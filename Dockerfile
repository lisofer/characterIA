# Compatibility launcher for Railway services building from the repository root.
# The application remains isolated in audio-video-studio/.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY audio-video-studio/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY audio-video-studio/main.py audio-video-studio/index.html /app/

ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers"]
