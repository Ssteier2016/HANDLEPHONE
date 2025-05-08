FROM python:3.11-slim

WORKDIR /app

# Instalar ffmpeg y dependencias del sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements.txt
COPY requirements.txt .

# Instalar dependencias de Python
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del proyecto
COPY . .

# Configurar el puerto
ENV PORT=8000

# Iniciar la aplicación
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "$PORT"]
