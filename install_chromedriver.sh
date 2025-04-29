#!/bin/bash
set -e  # Salir si hay algún error

echo "Iniciando instalación de dependencias para Chrome y ChromeDriver..."

# Instalar dependencias del sistema necesarias para Chrome y ChromeDriver
apt-get update
apt-get install -y libglib2.0-0 libnss3 libgconf-2-4 libfontconfig1 libxss1 libappindicator3-1 libindicator3-7

echo "Dependencias del sistema instaladas."

# Instalar Google Chrome
echo "Descargando Google Chrome..."
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
echo "Instalando Google Chrome..."
apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Verificar la versión de Chrome instalada
CHROME_VERSION=$(google-chrome --version || true)
echo "Versión de Chrome instalada: $CHROME_VERSION"

# Instalar una versión específica de ChromeDriver compatible con Chrome
# Nota: Ajustamos la versión según la versión de Chrome instalada
echo "Descargando ChromeDriver..."
wget -N https://chromedriver.storage.googleapis.com/114.0.5735.90/chromedriver_linux64.zip
echo "Descomprimiendo ChromeDriver..."
unzip chromedriver_linux64.zip
echo "Moviendo ChromeDriver a /usr/local/bin..."
mv chromedriver /usr/local/bin/chromedriver
chmod +x /usr/local/bin/chromedriver
rm chromedriver_linux64.zip

# Verificar que ChromeDriver está instalado y accesible
echo "Verificando instalación de ChromeDriver..."
if [ -f /usr/local/bin/chromedriver ]; then
    echo "ChromeDriver encontrado en /usr/local/bin/chromedriver"
    CHROMEDRIVER_VERSION=$(/usr/local/bin/chromedriver --version || true)
    echo "Versión de ChromeDriver instalada: $CHROMEDRIVER_VERSION"
else
    echo "ERROR: ChromeDriver no se encontró en /usr/local/bin/chromedriver"
    exit 1
fi

echo "Instalación de Chrome y ChromeDriver completada."
