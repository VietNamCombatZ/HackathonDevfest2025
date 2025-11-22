import os
import sys
import cv2
import numpy as np
import torch
from tqdm import tqdm
from ultralytics import YOLO
import segmentation_models_pytorch as smp
from push_data_realtime import push_flood_result

# ==============================
# 1. GLOBAL CONFIG
# ==============================

DEFAULT_SEG_WEIGHTS = "flood_segmentation_model.pth"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

ENV_DRY = "DRY"
ENV_WET = "WET"
ENV_FLOOD = "FLOOD"

YOLO_SHARED_MODEL = None


def get_shared_yolo():
    global YOLO_SHARED_MODEL
    if YOLO_SHARED_MODEL is None:
        YOLO_SHARED_MODEL = YOLO("yolov8n.pt")
    return YOLO_SHARED_MODEL

# Calibration constants (tune nếu cần)
DAMPING_FACTOR = 0.35      # giảm bớt độ ảo do mask hơi dày
MIN_DEPTH_THRESHOLD = 80   # mm – dưới mức này coi là đường ướt, không phải ngập

SCENE_DETECTION_CONFIG = {
    "sat_dry_max": 40.0,
    "edge_dry_min": 0.08,
    "var_rain_min": 10.0,
    "sat_flood_min": 60.0,
    "edge_flood_max": 0.05,
    "env_dry_sat_margin": 0.85,
    "env_dry_edge_margin": 1.0,
    "env_dry_var_margin": 0.65,
    "roi_bottom_ratio": 0.30,
    "max_scene_samples": 50,
    "sample_interval": 4,
    "min_flood_votes": 2,
    "flood_ratio_threshold": 0.3,
    "visual_score_threshold": 0.08,
    "visual_score_min_peak": 0.15,
    "sanity_frame_limit": 90,
    "min_visual_frames": 3,
    "min_object_frames": 1,
    "object_confidence": 0.35,
    "object_min_height_ratio": 0.09,
    "object_classes": [0, 3],
    "strong_vote_threshold": 3,
    "scene_dry_ratio": 0.7,
    "env_history_len": 12,
    "env_majority_ratio": 0.6,
    "env_min_consecutive": 3,
    "env_lock_after_flood": 30,
}


def get_road_roi_mask(frame_shape, bottom_ratio: float):
    """
    Tạo mask ROI cho phần mặt đường ở đáy khung hình.
    """
    h, w = frame_shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    bottom_ratio = max(0.0, min(1.0, float(bottom_ratio)))
    start_row = int(h * (1.0 - bottom_ratio))
    start_row = max(0, min(h, start_row))
    mask[start_row:h, :] = 1
    return mask


def compute_saturation_index(frame_bgr: np.ndarray, roi_mask: np.ndarray) -> float:
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    roi = roi_mask == 1
    if not np.any(roi):
        return 0.0
    return float(np.mean(saturation[roi]))


def compute_edge_index(frame_bgr: np.ndarray, roi_mask: np.ndarray) -> float:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    roi = roi_mask == 1
    if not np.any(roi):
        return 0.0
    edge_pixels = edges[roi]
    total_pixels = edge_pixels.size
    if total_pixels == 0:
        return 0.0
    return float(np.count_nonzero(edge_pixels) / total_pixels)


def compute_variance_index(frame_bgr: np.ndarray,
                           roi_mask: np.ndarray,
                           history: list,
                           max_history: int = 4) -> float:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    roi = roi_mask == 1
    if not np.any(roi):
        return 0.0
    curr = gray[roi]
    if len(history) == 0:
        history.append(curr.copy())
        return 0.0
    prev = history[-1]
    min_len = min(len(prev), len(curr))
    if min_len == 0:
        diff_score = 0.0
    else:
        diff = curr[:min_len].astype(np.float32) - prev[:min_len].astype(np.float32)
        diff_score = float(np.mean(np.abs(diff)))
    history.append(curr.copy())
    if len(history) > max_history:
        history.pop(0)
    return diff_score


def compute_scene_metrics(frame_bgr: np.ndarray,
                          roi_mask: np.ndarray,
                          history: list,
                          max_history: int = 4) -> dict:
    s_score = compute_saturation_index(frame_bgr, roi_mask)
    e_score = compute_edge_index(frame_bgr, roi_mask)
    v_score = compute_variance_index(frame_bgr, roi_mask, history, max_history=max_history)
    return {"s_score": s_score, "e_score": e_score, "v_score": v_score}


def compute_visual_water_ratio(frame_bgr: np.ndarray, roi_mask: np.ndarray) -> float:
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    s = hsv[:, :, 1]
    candidate = (v > 150) & (s < 120)
    candidate_mask = candidate.astype(np.uint8)
    kernel = np.ones((7, 7), np.uint8)
    candidate_mask = cv2.morphologyEx(candidate_mask, cv2.MORPH_OPEN, kernel)
    roi = roi_mask == 1
    if not np.any(roi):
        return 0.0
    overlap = np.logical_and(candidate_mask == 1, roi)
    total_roi = np.count_nonzero(roi)
    return float(np.count_nonzero(overlap) / max(1, total_roi))


def has_valid_object_detection(frame_bgr: np.ndarray,
                               model,
                               frame_height: int,
                               conf_threshold: float,
                               min_height_ratio: float,
                               classes=None) -> bool:
    """
    Detect objects quickly and return True if any bbox is tall enough.
    """
    if model is None:
        return False
    results = model(frame_bgr, verbose=False, conf=conf_threshold, classes=classes)[0]
    min_h = max(1.0, frame_height * float(min_height_ratio))
    for box in results.boxes:
        x1, y1, x2, y2 = box.xyxy[0]
        height = float(y2 - y1)
        if height >= min_h:
            return True
    return False


def classify_scene_state(scene_metrics: dict, config: dict) -> str:
    s_score = scene_metrics.get("s_score", 0.0)
    e_score = scene_metrics.get("e_score", 0.0)
    v_score = scene_metrics.get("v_score", 0.0)

    sat_dry_max = float(config.get("sat_dry_max", 40.0))
    edge_dry_min = float(config.get("edge_dry_min", 0.15))
    var_rain_min = float(config.get("var_rain_min", 10.0))
    sat_flood_min = float(config.get("sat_flood_min", 60.0))
    edge_flood_max = float(config.get("edge_flood_max", 0.05))
    env_dry_sat_margin = float(config.get("env_dry_sat_margin", 0.8))
    env_dry_edge_margin = float(config.get("env_dry_edge_margin", 1.1))
    env_dry_var_margin = float(config.get("env_dry_var_margin", 0.6))

    is_flood = (s_score >= sat_flood_min) or (e_score <= edge_flood_max)
    strict_sat = sat_dry_max * env_dry_sat_margin
    strict_edge = edge_dry_min * env_dry_edge_margin
    strict_var = var_rain_min * env_dry_var_margin
    is_dry = (
        (s_score <= strict_sat)
        and (e_score >= strict_edge)
        and (v_score < strict_var)
        and (s_score < sat_flood_min * 0.9)
    )

    if is_flood:
        return ENV_FLOOD
    if is_dry:
        return ENV_DRY
    if v_score >= var_rain_min:
        return ENV_WET
    return ENV_WET


def smooth_env_state(raw_state: str,
                     env_history: list,
                     prev_state: str | None,
                     flood_lock: dict,
                     config: dict) -> tuple[str, dict]:
    """
    Giảm nhấp nháy trạng thái ENV bằng majority/hysteresis như trong notebook:
      - Lưu history dài env_history_len.
      - Ưu tiên FLOOD với cơ chế lock nếu streak dài.
      - Yêu cầu min_consecutive / majority ratio trước khi đổi trạng thái.
    """
    history_len = int(config.get("env_history_len", 12))
    min_majority_ratio = float(config.get("env_majority_ratio", 0.6))
    min_consecutive = int(config.get("env_min_consecutive", 3))
    lock_after_flood = int(config.get("env_lock_after_flood", 30))

    env_history.append(raw_state)
    if len(env_history) > history_len:
        env_history.pop(0)

    if raw_state == ENV_FLOOD:
        flood_lock["streak"] = flood_lock.get("streak", 0) + 1
    else:
        flood_lock["streak"] = 0

    if flood_lock.get("locked", False) or flood_lock["streak"] >= lock_after_flood:
        flood_lock["locked"] = True
        return ENV_FLOOD, flood_lock

    if prev_state is None or raw_state == prev_state:
        return raw_state, flood_lock

    consecutive = 0
    for state in reversed(env_history):
        if state == raw_state:
            consecutive += 1
        else:
            break
    if consecutive >= min_consecutive:
        return raw_state, flood_lock

    counts = {}
    for state in env_history:
        counts[state] = counts.get(state, 0) + 1
    majority_state = max(counts, key=counts.get)
    majority_count = counts[majority_state]
    required_majority = max(int(min_majority_ratio * max(len(env_history), 1)), min_consecutive)
    if majority_state != prev_state and majority_count >= required_majority:
        return majority_state, flood_lock

    return prev_state, flood_lock


def detect_potential_flood(video_path: str,
                           config: dict = None,
                           yolo_model=None) -> tuple[bool, dict]:
    """
    Dò trạng thái môi trường (S/E/V + visual) đơn giản trước khi chạy pipeline chính.
    """
    if config is None:
        config = SCENE_DETECTION_CONFIG

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Không mở được video để dò môi trường: {video_path}")

    roi_mask = None
    roi_history = []
    flood_votes = 0
    env_states = []
    env_states_raw = []
    scene_metrics_samples = []
    visual_scores = []
    visual_trigger_frames = 0
    object_hits = 0
    samples = 0
    interval = max(1, int(config.get("sample_interval", 5)))
    max_samples = max(1, int(config.get("max_scene_samples", 30)))
    frame_idx = 0
    env_history_states = []
    env_state_smoothed = None
    flood_lock_state = {"locked": False, "streak": 0}

    if yolo_model is None:
        yolo_model = get_shared_yolo()

    try:
        while samples < max_samples:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % interval != 0:
                frame_idx += 1
                continue

            if roi_mask is None:
                bottom_ratio = float(config.get("roi_bottom_ratio", 0.30))
                roi_mask = get_road_roi_mask(frame.shape, bottom_ratio)

            scene_metrics = compute_scene_metrics(frame, roi_mask, roi_history)
            scene_metrics_samples.append(scene_metrics)
            env_state_raw = classify_scene_state(scene_metrics, config)
            env_states_raw.append(env_state_raw)
            env_state_smoothed, flood_lock_state = smooth_env_state(
                env_state_raw,
                env_history_states,
                env_state_smoothed,
                flood_lock_state,
                config,
            )
            env_states.append(env_state_smoothed)
            if env_state_smoothed == ENV_FLOOD:
                flood_votes += 1

            visual_ratio = compute_visual_water_ratio(frame, roi_mask)
            visual_scores.append(visual_ratio)
            visual_threshold = float(config.get("visual_score_threshold", 0.08))
            if visual_ratio >= visual_threshold:
                visual_trigger_frames += 1

            if has_valid_object_detection(
                frame,
                yolo_model,
                frame.shape[0],
                config.get("object_confidence", 0.35),
                config.get("object_min_height_ratio", 0.09),
                config.get("object_classes", [0, 3]),
            ):
                object_hits += 1

            samples += 1
            frame_idx += 1
    finally:
        cap.release()

    if samples == 0:
        return False, {
            "samples": 0,
            "flood_votes": 0,
            "env_states": [],
            "visual_mean": 0.0,
            "avg_env_state": ENV_DRY,
            "dry_ratio": 0.0,
            "scene_avg_metrics": {"s_score": 0.0, "e_score": 0.0, "v_score": 0.0},
        }

    min_votes = max(1, int(config.get("min_flood_votes", 1)))
    flood_ratio = float(config.get("flood_ratio_threshold", 0.35))
    visual_mean = float(np.mean(visual_scores)) if visual_scores else 0.0
    visual_peak = float(max(visual_scores)) if visual_scores else 0.0
    visual_threshold = float(config.get("visual_score_threshold", 0.08))
    visual_peak_threshold = float(config.get("visual_score_min_peak", 0.15))
    min_visual_frames = max(1, int(config.get("min_visual_frames", 2)))
    min_object_frames = max(1, int(config.get("min_object_frames", 1)))

    visual_frames = sum(1 for v in visual_scores if v >= visual_threshold)
    visual_signal = (visual_frames >= min_visual_frames) and (visual_mean >= visual_threshold)
    object_signal = object_hits >= min_object_frames
    vote_ratio = float(flood_votes) / max(1, samples) if samples > 0 else 0.0
    vote_signal = (flood_votes >= min_votes) and (vote_ratio >= flood_ratio)
    peak_signal = visual_peak >= visual_peak_threshold
    strong_threshold = max(int(config.get("strong_vote_threshold", max(2, min_votes + 1))), min_votes + 1)
    strong_vote_signal = (flood_votes >= strong_threshold) and visual_signal

    wet_votes = sum(1 for state in env_states if state == ENV_WET)
    dry_votes = sum(1 for state in env_states if state == ENV_DRY)

    flood_detected = (
        (vote_signal and (visual_signal or object_signal))
        or (visual_signal and object_signal and peak_signal)
        or strong_vote_signal
    )

    if scene_metrics_samples:
        avg_s_score = float(np.mean([m.get("s_score", 0.0) for m in scene_metrics_samples]))
        avg_e_score = float(np.mean([m.get("e_score", 0.0) for m in scene_metrics_samples]))
        avg_v_score = float(np.mean([m.get("v_score", 0.0) for m in scene_metrics_samples]))
    else:
        avg_s_score = avg_e_score = avg_v_score = 0.0
    scene_avg_metrics = {
        "s_score": avg_s_score,
        "e_score": avg_e_score,
        "v_score": avg_v_score,
    }
    avg_env_state = classify_scene_state(scene_avg_metrics, config)
    dry_ratio = float(dry_votes) / max(1, samples)
    if env_states:
        counts = {}
        for state in env_states:
            counts[state] = counts.get(state, 0) + 1
        majority_env_state = max(counts, key=counts.get)
    else:
        majority_env_state = avg_env_state

    return flood_detected, {
        "samples": samples,
        "flood_votes": flood_votes,
        "env_states": env_states,
        "dry_votes": dry_votes,
        "wet_votes": wet_votes,
        "visual_mean": visual_mean,
        "visual_peak": visual_peak,
        "visual_trigger_frames": visual_trigger_frames,
        "object_hits": object_hits,
        "vote_ratio": vote_ratio,
        "dry_ratio": dry_ratio,
        "scene_avg_metrics": scene_avg_metrics,
        "avg_env_state": avg_env_state,
        "majority_env_state": majority_env_state,
    }


class PrecisionSystem:
    """
    Hệ thống đo ngập dựa trên:
    - YOLOv8n: phát hiện object
    - U-Net đã fine-tune: segment vùng nước
    - Heuristic hình học: quy đổi pixel -> mm và lọc nước bắn
    """
    def __init__(self, seg_path: str, device: str = DEVICE, yolo_model=None):
        self.device = device
        print(f"--- 🔄 Khởi tạo hệ thống Precision 12cm (Device: {device}) ---")

        # 1) YOLO detector
        if yolo_model is None:
            if YOLO_SHARED_MODEL is None:
                print("1. Tải YOLOv8-nano (phát hiện đối tượng)...")
            else:
                print("1. Sử dụng lại YOLOv8-nano đã tải sẵn.")
            self.model = get_shared_yolo()
        else:
            self.model = yolo_model

        # 2) U-Net segmentor (dùng weights đã fine-tune)
        print(f"2. Tải U-Net (weights: {seg_path})...")
        self.segmentor = smp.Unet(
            encoder_name="mobilenet_v2",
            encoder_weights=None,  # không cần imagenet vì đã có weights custom
            in_channels=3,
            classes=1,
            activation=None,
        ).to(self.device)

        if not os.path.exists(seg_path):
            raise FileNotFoundError(
                f"Không tìm thấy file weights segmentation: {seg_path}.\n"
                f"Hãy đảm bảo flood_segmentation_model.pth nằm cạnh file .py này "
                f"hoặc truyền đúng đường dẫn bằng --seg-weights."
            )

        state = torch.load(seg_path, map_location=self.device)
        self.segmentor.load_state_dict(state)
        self.segmentor.eval()
        print("✅ Đã nạp thành công model segmentation!")

        # CLAHE để cải thiện tương phản
        self.clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))

    # --------------------------
    # Tiền xử lý & segmentation
    # --------------------------
    def preprocess_image(self, img: np.ndarray) -> np.ndarray:
        """Tăng tương phản bằng CLAHE trên kênh L (LAB)."""
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = self.clahe.apply(l)
        return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)

    def get_water_mask(self, img_bgr: np.ndarray) -> np.ndarray:
        """
        Chạy U-Net để lấy mask nước (binary 0/1) kích thước bằng frame gốc.
        """
        h, w = img_bgr.shape[:2]

        # Resize về kích thước train (320x320)
        img_resized = cv2.resize(img_bgr, (320, 320))

        # Chuẩn hóa như lúc train
        img_float = img_resized.astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img_norm = (img_float - mean) / std

        img_tensor = (
            torch.from_numpy(img_norm)
            .float()
            .permute(2, 0, 1)
            .unsqueeze(0)
            .to(self.device)
        )

        with torch.no_grad():
            logits = self.segmentor(img_tensor)
            mask_prob = torch.sigmoid(logits).cpu().numpy()[0, 0]

        # Resize mask về kích thước gốc (h, w)
        full_mask = cv2.resize(mask_prob, (w, h))
        binary_mask = (full_mask > 0.6).astype(np.uint8)

        # Morphological close để lấp khoảng trống nhỏ
        kernel = np.ones((11, 11), np.uint8)
        return cv2.morphologyEx(binary_mask, cv2.MORPH_CLOSE, kernel)

    # --------------------------
    # Đo chiều cao nước đặc
    # --------------------------
    @staticmethod
    def measure_solid_water_height(roi_mask: np.ndarray) -> int:
        """
        Đo chiều cao nước 'ĐẶC' (solid water) trong ROI:
        - Tính mật độ nước theo từng dòng (row)
        - Quét từ dưới lên, chỉ cộng những dòng có mật độ >= 50%
        - Gặp vùng loãng (mật độ nhỏ) sau khi đã tích lũy đủ vài dòng thì dừng
        """
        if roi_mask.size == 0:
            return 0

        # Mỗi phần tử trong row_density ∈ [0,1] (tỷ lệ pixel nước trên dòng đó)
        row_density = np.mean(roi_mask, axis=1)

        solid_pixel_count = 0
        tolerance = 5  # cho phép vài dòng nhiễu mỏng ở đáy

        for density in reversed(row_density):
            if density > 0.5:
                solid_pixel_count += 1
            else:
                if solid_pixel_count > tolerance:
                    break

        return solid_pixel_count

    # --------------------------
    # Phân tích 1 bounding box
    # --------------------------
    def analyze_object(self, box, water_mask: np.ndarray):
        """
        Tính độ ngập (mm) cho 1 object (box) dựa trên water_mask.
        Trả về: (depth_mm, status_str)
        """
        x1, y1, x2, y2 = map(int, box)
        box_h = y2 - y1
        box_w = x2 - x1

        # 1) mm/pixel: giả sử chiều cao thân xe/người ~ 1600mm
        expected_h = max(1, box_w * 1.6)  # có thể tinh chỉnh tỉ lệ này
        mm_per_px = 1600.0 / expected_h

        # 2) Cắt vùng chân (30% dưới cùng + mở rộng xuống thêm vài px)
        roi_h = int(box_h * 0.3)
        roi_y_start = max(0, y2 - roi_h)
        roi_y_end = min(water_mask.shape[0], y2 + 5)

        roi_mask = water_mask[roi_y_start:roi_y_end, x1:x2]

        # 3) Đo chiều cao nước đặc
        water_px_height = self.measure_solid_water_height(roi_mask)

        if water_px_height <= 0:
            return 0.0, "DRY"

        # 4) Quy đổi pixel -> mm + hệ số hiệu chuẩn
        raw_depth_mm = water_px_height * mm_per_px
        final_depth = raw_depth_mm * DAMPING_FACTOR

        # 5) Lọc kết quả
        if final_depth < MIN_DEPTH_THRESHOLD:
            # Đường ướt / vũng nước nhỏ
            return 0.0, "WET"
        if final_depth > 800:
            # Giá trị ảo, bỏ qua
            return 0.0, "ERR"

        return float(final_depth), "FLOOD"

    # --------------------------
    # Xử lý 1 frame
    # --------------------------
    def process_frame(self, frame: np.ndarray, current_avg: float):
        """
        Xử lý 1 frame:
        - segmentation nước
        - detect object
        - tính depth cho từng object
        - vẽ overlay
        """
        processed = self.preprocess_image(frame)
        vis_img = frame.copy()
        h_img, w_img = frame.shape[:2]

        # 1) Water mask
        water_mask = self.get_water_mask(processed)

        # 2) Vẽ mask mờ lên frame
        colored_mask = np.zeros_like(vis_img)
        colored_mask[water_mask == 1] = [255, 100, 0]  # màu cam/xanh tuỳ ý
        vis_img = cv2.addWeighted(vis_img, 1.0, colored_mask, 0.2, 0)

        # 3) YOLO detect
        # classes=[0, 3] chỉ là ví dụ (person, motorbike).
        # Nếu muốn chỉ xe hơi/bus/truck, có thể đổi sang [2, 5, 7].
        results = self.model(processed, verbose=False, conf=0.3, classes=[0, 3])

        frame_depths = []

        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                if (y2 - y1) < h_img * 0.08:
                    # Box quá nhỏ, bỏ qua
                    continue

                depth_mm, status = self.analyze_object((x1, y1, x2, y2), water_mask)

                if depth_mm > 0:
                    frame_depths.append(depth_mm)

                    # Màu box theo mức ngập
                    if depth_mm > 300:
                        color = (0, 0, 255)      # >30cm: đỏ
                    elif depth_mm > 150:
                        color = (0, 165, 255)    # 15–30cm: cam
                    else:
                        color = (0, 255, 255)    # 8–15cm: vàng

                    cv2.rectangle(vis_img, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(
                        vis_img,
                        f"{int(depth_mm)} mm",
                        (x2 + 5, y2),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        color,
                        2,
                    )

        # 4) Dashboard nhỏ ở đầu frame
        cv2.rectangle(vis_img, (0, 0), (w_img, 80), (0, 0, 0), -1)

        if frame_depths:
            inst_avg = int(np.mean(frame_depths))
            inst_status = f"DETECTING: {inst_avg} mm"
            color = (0, 255, 255)
        else:
            inst_status = "NO FLOOD OBJECT DETECTED"
            color = (0, 255, 0)

        cv2.putText(
            vis_img,
            inst_status,
            (20, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            color,
            2,
        )
        cv2.putText(
            vis_img,
            f"AVG SESSION: {int(current_avg)} mm",
            (20, 65),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (255, 255, 255),
            2,
        )

        return vis_img, frame_depths


def process_video(video_path: str,
                  seg_weights: str = DEFAULT_SEG_WEIGHTS,
                  output_path=None,
                  frame_limit=None,
                  early_exit_on_flood=False,
                  write_output=True,
                  yolo_model=None) -> dict:
    """
    Hàm chính: đọc video, chạy PrecisionSystem.
    Các tham số mở rộng để hỗ trợ kiểm tra khô nhanh:
      - frame_limit: số frame tối đa sẽ xử lý trong lần chạy này.
      - early_exit_on_flood: nếu phát hiện mức ngập >0 thì dừng sớm.
      - write_output: nếu False thì không ghi video kết quả.
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Không tìm thấy file video: {video_path}")

    resolved_output = output_path
    if write_output and resolved_output is None:
        base, _ = os.path.splitext(video_path)
        resolved_output = f"{base}_result.mp4"

    system = PrecisionSystem(seg_weights, device=DEVICE, yolo_model=yolo_model)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Không mở được video: {video_path}")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        fps = 24.0

    writer = None
    if write_output:
        if resolved_output is None:
            raise RuntimeError("Không thể tạo writer vì đường dẫn đầu ra chưa được xác định.")
        ext = os.path.splitext(resolved_output)[1].lower()
        if ext == ".webm":
            fourcc = cv2.VideoWriter_fourcc(*"VP80")
        else:
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")

        writer = cv2.VideoWriter(resolved_output, fourcc, fps, (w, h))

    frame_limit = None if frame_limit is None else max(1, int(frame_limit))

    all_readings = []  # kiểu: List[float]
    current_avg = 0.0

    print(f"\n🎬 Đang xử lý video: {video_path}")
    print(f"Kích thước: {w}x{h}, FPS: {fps:.1f}, Tổng số frame: {total}")
    if frame_limit is not None:
        print(f"ℹ️ Giới hạn sanity mode: tối đa {frame_limit} frame.")

    pbar_total = None if total <= 0 else total
    if frame_limit is not None and total > 0:
        pbar_total = min(total, frame_limit)

    pbar = tqdm(total=pbar_total, desc="Processing frames")
    frames_processed = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        depths = []
        try:
            res_frame, depths = system.process_frame(frame, current_avg)
            if write_output and writer is not None:
                writer.write(res_frame)
            if depths:
                all_readings.extend(depths)
                current_avg = float(np.mean(all_readings))
        except Exception as e:
            print(f"⚠️ Lỗi khi xử lý 1 frame: {e}")

        frames_processed += 1
        pbar.update(1)

        if early_exit_on_flood and depths:
            break
        if frame_limit is not None and frames_processed >= frame_limit:
            break

    pbar.close()
    cap.release()
    if writer is not None:
        writer.release()

    print("\n" + "=" * 60)
    if all_readings:
        final_val = int(current_avg)
        status = "FLOODED" if final_val >= MIN_DEPTH_THRESHOLD else "DRY_OR_WET"
        print(f"🎯 KẾT QUẢ CUỐI CÙNG: {final_val} mm  |  TRẠNG THÁI: {status}")
        
        # ✅ Push lên Firebase
        # DRY_OR_WET với final_val >= 80mm vẫn coi là có ngập
        is_flooded = (status == "FLOODED")
        try:
            push_flood_result(final_val, is_flooded)
        except Exception as e:
            print(f"⚠️ Không thể push lên Firebase: {e}")
        
    else:
        final_val = 0
        status = "NO_VEHICLE_OR_NO_FLOOD"
        print("❗ Không tìm thấy đối tượng nào có ngập nước đáng kể trong video.")
        print("🎯 KẾT QUẢ CUỐI CÙNG: 0 mm  |  TRẠNG THÁI: NO_VEHICLE_OR_NO_FLOOD")
        
        # ✅ Push trạng thái không ngập
        try:
            push_flood_result(0, False)
        except Exception as e:
            print(f"⚠️ Không thể push lên Firebase: {e}")
    
    if write_output and resolved_output:
        print(f"📁 Video kết quả đã lưu tại: {resolved_output}")
    else:
        print("ℹ️ Không tạo video kết quả trong chế độ kiểm tra nhanh.")
    if frame_limit is not None:
        print(f"ℹ️ Tổng số frame đã kiểm tra: {frames_processed}")
    print("=" * 60 + "\n")

    return {
        "final_depth": final_val,
        "status": status,
        "frames_processed": frames_processed,
        "flood_found": bool(all_readings),
        "output_path": resolved_output if write_output else None,
    }

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Đo mức độ ngập (mm) từ video giao thông bằng YOLOv8 + U-Net đã fine-tune."
    )
    parser.add_argument(
        "--video",
        "-v",
        required=True,
        help="Đường dẫn tới file video đầu vào, ví dụ: videos/test_12cm.mp4",
    )
    parser.add_argument(
        "--seg-weights",
        "-w",
        default=DEFAULT_SEG_WEIGHTS,
        help="Đường dẫn tới file weights U-Net đã fine-tune (mặc định: flood_segmentation_model.pth).",
    )
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="Đường dẫn video kết quả (nếu bỏ trống sẽ tạo *_result.mp4 cạnh file gốc).",
    )

    args = parser.parse_args()

    yolo_model = get_shared_yolo()
    flood_detected, flood_stats = detect_potential_flood(
        args.video,
        yolo_model=yolo_model,
    )

    samples = flood_stats.get("samples", 0)
    votes = flood_stats.get("flood_votes", 0)
    visual_mean = flood_stats.get("visual_mean", 0.0)
    visual_peak = flood_stats.get("visual_peak", 0.0)
    visual_triggers = flood_stats.get("visual_trigger_frames", 0)
    object_hits = flood_stats.get("object_hits", 0)
    vote_ratio = flood_stats.get("vote_ratio", 0.0)
    avg_env_state = flood_stats.get("avg_env_state", ENV_DRY)
    majority_env_state = flood_stats.get("majority_env_state", avg_env_state)
    dry_ratio = float(flood_stats.get("dry_ratio", 0.0))
    scene_avg_metrics = flood_stats.get(
        "scene_avg_metrics", {"s_score": 0.0, "e_score": 0.0, "v_score": 0.0}
    )
    scene_dry_ratio = float(SCENE_DETECTION_CONFIG.get("scene_dry_ratio", 0.7))

    dry_confident = (
        samples > 0
        and dry_ratio >= scene_dry_ratio
        and (avg_env_state == ENV_DRY or majority_env_state == ENV_DRY)
    )
    min_votes = max(1, int(SCENE_DETECTION_CONFIG.get("min_flood_votes", 2)))
    flood_ratio_thr = float(SCENE_DETECTION_CONFIG.get("flood_ratio_threshold", 0.35))
    flood_confident = (
        flood_detected
        and (
            majority_env_state == ENV_FLOOD
            or avg_env_state == ENV_FLOOD
            or (votes >= min_votes and vote_ratio >= flood_ratio_thr)
        )
    )

    if dry_confident:
        s_score = scene_avg_metrics.get("s_score", 0.0)
        e_score = scene_avg_metrics.get("e_score", 0.0)
        v_score = scene_avg_metrics.get("v_score", 0.0)
        print("\n✅ 3 chỉ số cảnh (S/E/V) cho thấy môi trường KHÔ → bỏ qua pipeline đo chiều cao.")
        print(
            f"   → S={s_score:.1f}, E={e_score:.3f}, V={v_score:.1f}, dry ratio={dry_ratio:.2f}"
        )
        print(f"   → Mẫu đã kiểm tra: {samples}, flood votes: {votes}, visual peak: {visual_peak:.3f}")
        
        # ✅ THÊM: Push trạng thái DRY trước khi exit
        try:
            push_flood_result(0, False)
        except Exception as e:
            print(f"⚠️ Không thể push lên Firebase: {e}")
        
        sys.exit(0)
    elif flood_confident:
        print("\n✅ Dò môi trường sơ bộ cho thấy có dấu hiệu ngập → tiếp tục chạy pipeline đầy đủ.")
        process_video(
            args.video,
            seg_weights=args.seg_weights,
            output_path=args.output,
            yolo_model=yolo_model,
        )
    else:
        print("\n❗ Dò môi trường sơ bộ cho thấy tình huống KHÔ / chưa rõ ràng.")
        print(
            f"   → Mẫu đã kiểm tra: {samples}, flood votes: {votes}, vote ratio: {vote_ratio:.2f}"
        )
        print(
            f"   → Visual score: mean={visual_mean:.3f}, peak={visual_peak:.3f}, triggers={visual_triggers}"
        )
        print(f"   → Object hit frames: {object_hits}")

        sanity_limit = int(SCENE_DETECTION_CONFIG.get("sanity_frame_limit", 90))
        fallback = process_video(
            args.video,
            seg_weights=args.seg_weights,
            output_path=None,
            frame_limit=sanity_limit,
            early_exit_on_flood=True,
            write_output=False,
            yolo_model=yolo_model,
        )

        if fallback["flood_found"]:
            print("\n⚠️ Sanity check phát hiện đối tượng ngập → chạy lại pipeline đầy đủ.")
            process_video(
                args.video,
                seg_weights=args.seg_weights,
                output_path=args.output,
                yolo_model=yolo_model,
            )
        else:
            print("\n🎯 Sau sanity check không tìm thấy ngập → kết thúc với trạng thái DRY, 0 mm.")
            print(f"ℹ️ Khung hình được xử lý trong sanity run: {fallback['frames_processed']}")
            
            # ✅ THÊM: Push trạng thái DRY trước khi exit
            try:
                push_flood_result(0, False)
            except Exception as e:
                print(f"⚠️ Không thể push lên Firebase: {e}")
            
            sys.exit(0)