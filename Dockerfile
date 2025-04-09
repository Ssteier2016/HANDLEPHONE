# Usar una imagen base de Python 3.11 (versión completa, no slim)
FROM python:3.11

# Instalar dependencias del sistema necesarias para PyAudio, Vosk, http-ece y herramientas adicionales
RUN apt-get update && apt-get install -y \
    portaudio19-dev \
    gcc \
    build-essential \
    ffmpeg \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar requirements.txt primero para aprovechar el cache de Docker
COPY requirements.txt .

# Actualizar pip, instalar wheel e instalar las dependencias en una sola línea
RUN pip install --upgrade pip wheel && pip install --no-cache-dir -r requirements.txt

# Copiar el resto de los archivos del proyecto
COPY . .

# Exponer el puerto (Render usa PORT, por defecto 10000)
ENV PORT=10000
EXPOSE $PORT

# Comando para iniciar la aplicación
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "$PORT"]
