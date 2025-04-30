# Usar una imagen base de Python 3.11
FROM python:3.11-slim

# Instalar dependencias del sistema necesarias para audio y compilación
RUN apt-get update && apt-get install -y \
    gcc \
    libffi-dev \
    ffmpeg \
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

# Comando para iniciar la aplicación
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
