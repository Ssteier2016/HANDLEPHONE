# Usar una imagen base de Python 3.9
FROM python:3.9

# Instalar dependencias del sistema necesarias para PyAudio, Vosk y herramientas adicionales
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

# Actualizar pip e instalar wheel en un paso separado
RUN pip install --upgrade pip && pip install wheel

# Instalar las dependencias en un paso separado
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto de los archivos del proyecto
COPY . .

# Exponer el puerto (Render usa PORT, por defecto 10000)
ENV PORT=10000
EXPOSE $PORT

# Comando para iniciar la aplicación (usar formato de shell para sustitución de variables)
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
