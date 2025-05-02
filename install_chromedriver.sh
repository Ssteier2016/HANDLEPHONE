#!/bin/bash
set -e  # Salir si hay algún error

echo "Iniciando instalación de Google Chrome y ChromeDriver..."

# Instalar dependencias adicionales necesarias para Google Chrome
echo "Instalando dependencias..."
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    libu2f-udev \
    libvulkan1

# Descargar e instalar Google Chrome
echo "Descargando Google Chrome..."
curl -sSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o google-chrome-stable_current_amd64.deb

echo "Instalando Google Chrome..."
apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Verificar la versión de Chrome instalada
CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de Chrome instalada: $CHROME_VERSION"

# Obtener la versión principal de Chrome (primeros tres números, ej. 128.0.6613)
CHROME_MAJOR_VERSION=$(echo $CHROME_VERSION | cut -d. -f1-3)
echo "Versión principal de Chrome: $CHROME_MAJOR_VERSION"

# Descargar e instalar ChromeDriver compatible
echo "Descargando ChromeDriver..."
CHROMEDRIVER_URL="https://chromedriver.storage.googleapis.com/LATEST_RELEASE_${CHROME_MAJOR_VERSION}"
CHROMEDRIVER_VERSION=$(curl -sS $CHROMEDRIVER_URL || echo "latest")
if [ "$CHROMEDRIVER_VERSION" = "latest" ]; then
    CHROMEDRIVER_VERSION=$(curl -sS https://chromedriver.storage.googleapis.com/LATEST_RELEASE)
fi
echo "Versión de ChromeDriver a instalar: $CHROMEDRIVER_VERSION"

curl -sSL https://chromedriver.storage.googleapis.com/${CHROMEDRIVER_VERSION}/chromedriver_linux64.zip -o chromedriver_linux64.zip
unzip chromedriver_linux64.zip
mv chromedriver /usr/local/bin/
chmod +x /usr/local/bin/chromedriver
rm chromedriver_linux64.zip

# Verificar la versión de ChromeDriver instalada
CHROMEDRIVER_INSTALLED_VERSION=$(chromedriver --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de ChromeDriver instalada: $CHROMEDRIVER_INSTALLED_VERSION"

# Limpiar caché de apt-get
echo "Limpiando caché de apt-get..."
apt-get clean
rm -rf /var/lib/apt/lists/*

echo "Instalación de Google Chrome y ChromeDriver completada."
