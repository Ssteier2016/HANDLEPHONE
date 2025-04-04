# Usar una imagen base de Python 3.11
FROM python:3.11-slim

# Instalar dependencias del sistema necesarias para PyAudio, compilación y descarga de Vosk
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    gcc \
    ffmpeg \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar todos los archivos del proyecto
COPY . .

# Instalar las dependencias de Python
RUN pip install --no-cache-dir -r requirements.txt

# Exponer el puerto
EXPOSE 8000

# Comando para iniciar la aplicación
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
