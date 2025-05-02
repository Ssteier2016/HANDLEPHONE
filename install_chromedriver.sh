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

# Descargar e instalar una versión específica de Google Chrome
CHROME_VERSION="114.0.5735.198"
echo "Descargando Google Chrome versión $CHROME_VERSION..."
curl -sSL https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb -o google-chrome-stable_${CHROME_VERSION}-1_amd64.deb

echo "Instalando Google Chrome..."
apt-get install -y ./google-chrome-stable_${CHROME_VERSION}-1_amd64.deb
rm google-chrome-stable_${CHROME_VERSION}-1_amd64.deb

# Verificar la versión de Chrome instalada
CHROME_INSTALLED_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de Chrome instalada: $CHROME_INSTALLED_VERSION"

# Obtener la versión principal de Chrome (primeros tres números, ej. 114.0.5735)
CHROME_MAJOR_VERSION=$(echo $CHROME_INSTALLED_VERSION | cut -d. -f1-3)
echo "Versión principal de Chrome: $CHROME_MAJOR_VERSION"

# Descargar e instalar ChromeDriver compatible
echo "Descargando ChromeDriver..."
CHROMEDRIVER_URL="https://chromedriver.storage.googleapis.com/LATEST_RELEASE_${CHROME_MAJOR_VERSION}"
CHROMEDRIVER_VERSION=$(curl -sS $CHROMEDRIVER_URL 2>/dev/null || echo "none")
if [ "$CHROMEDRIVER_VERSION" = "none" ] || [ -z "$CHROMEDRIVER_VERSION" ]; then
    echo "No se encontró ChromeDriver para $CHROME_MAJOR_VERSION, intentando con edgedl.me.gvt1.com..."
    CHROMEDRIVER_VERSION="$CHROME_MAJOR_VERSION"
    curl -sSL https://edgedl.me.gvt1.com/edgedl/chrome/chrome-for-testing/$CHROMEDRIVER_VERSION/linux64/chromedriver-linux64.zip -o chromedriver_linux64.zip
else
    echo "Versión de ChromeDriver encontrada: $CHROMEDRIVER_VERSION"
    curl -sSL https://chromedriver.storage.googleapis.com/${CHROMEDRIVER_VERSION}/chromedriver_linux64.zip -o chromedriver_linux64.zip
fi

unzip chromedriver_linux64.zip
mv chromedriver-linux64/chromedriver /usr/local/bin/
chmod +x /usr/local/bin/chromedriver
rm -rf chromedriver_linux64.zip chromedriver-linux64

# Verificar la versión de ChromeDriver instalada
CHROMEDRIVER_INSTALLED_VERSION=$(chromedriver --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de ChromeDriver instalada: $CHROMEDRIVER_INSTALLED_VERSION"

# Limpiar caché de apt-get
echo "Limpiando caché de apt-get..."
apt-get clean
rm -rf /var/lib/apt/lists/*

echo "Instalación de Google Chrome y ChromeDriver completada."
