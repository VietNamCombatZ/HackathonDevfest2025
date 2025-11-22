# Sử dụng Java 17
FROM openjdk:17-slim

WORKDIR /graphhopper

# 1. Tải GraphHopper (Bộ não)
RUN apt-get update && apt-get install -y wget
RUN wget https://graphhopper.com/public/releases/graphhopper-web-9.1.jar -O graphhopper.jar

# 2. Copy file cấu hình và bản đồ vào (Chỉ copy, không chạy lệnh nặng)
COPY vietnam.pbf .
COPY config.yml .

# 3. Mở cổng 8989
EXPOSE 8989

# 4. Lệnh chạy server (Kèm cấu hình RAM 2GB và import dữ liệu lúc khởi động)
CMD ["java", "-Xmx2g", "-Xms512m", "-Ddw.graphhopper.datareader.file=vietnam.pbf", "-Ddw.server.application_connectors[0].bind_host=0.0.0.0", "-jar", "graphhopper.jar", "server", "config.yml"]