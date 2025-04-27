#!/bin/bash
# Instalar dependencias del sistema necesarias para Chrome y ChromeDriver
apt-get update
apt-get install -y libglib2.0-0 libnss3 libgconf-2-4 libfontconfig1

# Instalar Google Chrome
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y ./google-chrome-stable_current_amd64.deb

# Obtener la versión de Chrome instalada
CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+\.\d+')
echo "Versión de Chrome instalada: $CHROME_VERSION"

# Instalar una versión compatible de ChromeDriver (usaremos una versión específica)
# Nota: Ajusta la versión según la versión de Chrome instalada
wget -N https://chromedriver.storage.googleapis.com/114.0.5735.90/chromedriver_linux64.zip
unzip chromedriver_linux64.zip
mv chromedriver /usr/local/bin/chromedriver
chmod +x /usr/local/bin/chromedriver

# Verificar que ChromeDriver está instalado
chromedriver --version
