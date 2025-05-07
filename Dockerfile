# Usar la imagen base de Python 3.11 slim
FROM python:3.11-slim

# Instalar dependencias del sistema necesarias para la aplicación
RUN apt-get update && apt-get install -y \
    gcc \
    libffi-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Establecer el directorio de trabajo
WORKDIR /app

# Copiar el archivo de requisitos
COPY requirements.txt .

# Actualizar pip e instalar las dependencias de Python
RUN pip install --upgrade pip && pip install wheel
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del código de la aplicación
COPY . .

# Exponer el puerto 8000
EXPOSE 8000

# Comando para iniciar la aplicación
CMD ["python", "main.py"]
