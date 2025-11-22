import os
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

# Calibration constants (tune nếu cần)
DAMPING_FACTOR = 0.35      # giảm bớt độ ảo do mask hơi dày
MIN_DEPTH_THRESHOLD = 80   # mm – dưới mức này coi là đường ướt, không phải ngập


class PrecisionSystem:
    """
    Hệ thống đo ngập dựa trên:
    - YOLOv8n: phát hiện object
    - U-Net đã fine-tune: segment vùng nước
    - Heuristic hình học: quy đổi pixel -> mm và lọc nước bắn
    """
    def __init__(self, seg_path: str, device: str = DEVICE):
        self.device = device
        print(f"--- 🔄 Khởi tạo hệ thống Precision 12cm (Device: {device}) ---")

        # 1) YOLO detector
        print("1. Tải YOLOv8-nano (phát hiện đối tượng)...")
        self.model = YOLO("yolov8n.pt")  # sẽ tự tải về nếu chưa có

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
                  output_path=None) -> None:
    """
    Hàm chính: đọc video, chạy PrecisionSystem, lưu video kết quả
    và in ra trạng thái ngập + độ ngập trung bình (mm).
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Không tìm thấy file video: {video_path}")

    if output_path is None:
        base, ext = os.path.splitext(video_path)
        output_path = f"{base}_result{ext if ext else '.mp4'}"

    system = PrecisionSystem(seg_weights, device=DEVICE)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Không mở được video: {video_path}")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0:
        fps = 24.0

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (w, h))

    all_readings = []  # kiểu: List[float]
    current_avg = 0.0

    print(f"\n🎬 Đang xử lý video: {video_path}")
    print(f"Kích thước: {w}x{h}, FPS: {fps:.1f}, Tổng số frame: {total}")
    for _ in tqdm(range(total), desc="Processing frames"):
        ret, frame = cap.read()
        if not ret:
            break

        try:
            res_frame, depths = system.process_frame(frame, current_avg)
            if depths:
                all_readings.extend(depths)
                current_avg = float(np.mean(all_readings))
            out.write(res_frame)
        except Exception as e:
            # Bỏ frame lỗi nhưng không dừng cả pipeline
            print(f"⚠️ Lỗi khi xử lý 1 frame: {e}")
            continue

    cap.release()
    out.release()

    print("\n" + "=" * 60)
    if all_readings:
        final_val = int(current_avg)
        status = "FLOODED" if final_val >= MIN_DEPTH_THRESHOLD else "DRY_OR_WET"
        print(f"🎯 KẾT QUẢ CUỐI CÙNG: {final_val} mm  |  TRẠNG THÁI: {status}")
    else:
        final_val = 0
        status = "NO_VEHICLE_OR_NO_FLOOD"
        print("❗ Không tìm thấy đối tượng nào có ngập nước đáng kể trong video.")
        print("🎯 KẾT QUẢ CUỐI CÙNG: 0 mm  |  TRẠNG THÁI: NO_VEHICLE_OR_NO_FLOOD")
    
    push_flood_result(final_val, status == "FLOODED")
    print(f"📁 Video kết quả đã lưu tại: {output_path}")
    print("=" * 60 + "\n")


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

    process_video(args.video, seg_weights=args.seg_weights, output_path=args.output)
