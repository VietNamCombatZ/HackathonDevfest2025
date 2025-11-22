# Sử dụng Java 17
FROM openjdk:17-slim

WORKDIR /graphhopper

# 1. Cài đặt wget để tải file
RUN apt-get update && apt-get install -y wget

# 2. Tải GraphHopper (Link Maven ổn định)
RUN wget https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/9.1/graphhopper-web-9.1.jar -O graphhopper.jar

# 3. TẢI BẢN ĐỒ TRỰC TIẾP (Sửa đoạn này)
# Thay vì COPY, ta dùng wget tải trực tiếp từ Geofabrik để không phải up file nặng lên GitHub
RUN wget https://download.geofabrik.de/asia/vietnam-latest.osm.pbf -O vietnam.pbf

# 4. Copy file cấu hình (File này nhẹ nên Copy được)
COPY config.yml .

# 5. Mở cổng 8989
EXPOSE 8989

# 6. Lệnh chạy server
# LƯU Ý: Render Free Tier chỉ cho 512MB RAM.
# Tôi đã chỉnh -Xmx xuống còn 400m để tránh bị Render giết tiến trình (OOM Kill).
# Nếu chạy bản đồ Vietnam mà bị crash, bạn cần nâng cấp Render hoặc cắt nhỏ bản đồ.
CMD ["java", "-Xmx400m", "-Xms256m", "-Ddw.graphhopper.datareader.file=vietnam.pbf", "-Ddw.server.application_connectors[0].bind_host=0.0.0.0", "-jar", "graphhopper.jar", "server", "config.yml"]