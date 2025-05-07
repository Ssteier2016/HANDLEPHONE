#!/bin/bash

set -e

echo "Iniciando instalación de Google Chrome y ChromeDriver..."

# Instalar dependencias necesarias
echo "Instalando dependencias..."
apt-get update
apt-get install -y curl libu2f-udev

# Descargar e instalar la clave GPG de Google
echo "Configurando el repositorio de Google Chrome..."
curl -fsSL https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list

# Actualizar e instalar Google Chrome
apt-get update
apt-get install -y google-chrome-stable

# Obtener la versión instalada de Chrome
CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+')
echo "Versión de Google Chrome instalada: $CHROME_VERSION"

# Descargar e instalar ChromeDriver compatible
echo "Descargando ChromeDriver compatible con la versión $CHROME_VERSION..."
curl -o chromedriver.zip "https://chromedriver.storage.googleapis.com/LATEST_RELEASE_${CHROME_VERSION}"
CHROMEDRIVER_VERSION=$(cat chromedriver.zip)
curl -o chromedriver.zip "https://chromedriver.storage.googleapis.com/${CHROMEDRIVER_VERSION}/chromedriver_linux64.zip"
unzip chromedriver.zip
mv chromedriver /usr/local/bin/
chmod +x /usr/local/bin/chromedriver
rm chromedriver.zip

echo "Instalación completada."
