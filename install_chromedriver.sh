#!/bin/bash
set -e  # Salir si hay algún error

echo "Iniciando instalación de Google Chrome..."

# Descargar e instalar Google Chrome
echo "Descargando Google Chrome..."
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

echo "Instalando Google Chrome..."
apt-get update
apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Verificar la versión de Chrome instalada
CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de Chrome instalada: $CHROME_VERSION"

echo "Instalación de Google Chrome completada."
