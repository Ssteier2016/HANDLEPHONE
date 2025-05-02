FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gcc \
    libffi-dev \
    ffmpeg \
    wget \
    unzip \
    libxss1 \
    libayatana-appindicator3-1 \
    libayatana-indicator3-7 \
    fonts-liberation \
    libasound2 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    xdg-utils \
    libglib2.0-0 \
    libgconf-2-4 \
    libfontconfig1 \
    && rm -rf /var/lib/apt/lists/* || { echo "Error installing dependencies"; exit 1; }

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip && pip install wheel
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

COPY install_chromedriver.sh .
RUN chmod +x install_chromedriver.sh && ./install_chromedriver.sh

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
