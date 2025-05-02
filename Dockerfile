FROM python:3.11-slim

RUN apt-get update && apt-get install -y 
gcc 
libffi-dev 
ffmpeg 
&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN pip install --upgrade pip && pip install wheel RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=10000 EXPOSE $PORT

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "$PORT"]
