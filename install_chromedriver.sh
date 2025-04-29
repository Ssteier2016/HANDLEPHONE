#!/bin/bash
set -e  # Salir si hay algún error

echo "Iniciando instalación de dependencias para Chrome y ChromeDriver..."

# Instalar dependencias del sistema necesarias para Chrome y ChromeDriver
apt-get update
apt-get install -y libglib2.0-0 libnss3 libgconf-2-4 libfontconfig1 libxss1 libappindicator3-1

echo "Dependencias del sistema instaladas."

# Instalar Google Chrome
echo "Descargando Google Chrome..."
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
echo "Instalando Google Chrome..."
apt-get install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Verificar la versión de Chrome instalada
CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+\.\d+' || true)
echo "Versión de Chrome instalada: $CHROME_VERSION"

# Obtener la versión compatible de ChromeDriver
echo "Obteniendo la versión compatible de ChromeDriver..."
CHROME_MAJOR_VERSION=${CHROME_VERSION%%.*}
CHROMEDRIVER_VERSION=$(curl -sS "https://chromedriver.storage.googleapis.com/LATEST_RELEASE_${CHROME_MAJOR_VERSION}" || true)

# Verificar si se obtuvo una versión válida
if [ -z "$CHROMEDRIVER_VERSION" ] || echo "$CHROMEDRIVER_VERSION" | grep -q "Error"; then
    echo "No se pudo obtener la versión de ChromeDriver para Chrome $CHROME_MAJOR_VERSION. Usando una versión reciente conocida..."
    CHROMEDRIVER_VERSION="126.0.6478.126"  # Fallback a una versión conocida compatible con Chrome 126
fi
echo "Versión de ChromeDriver a instalar: $CHROMEDRIVER_VERSION"

# Descargar e instalar ChromeDriver
echo "Descargando ChromeDriver $CHROMEDRIVER_VERSION..."
if wget -N "https://chromedriver.storage.googleapis.com/${CHROMEDRIVER_VERSION}/chromedriver_linux64.zip"; then
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
        echo "Continuando el despliegue sin ChromeDriver, los scrapers que dependen de Selenium no funcionarán."
    fi
else
    echo "ERROR: No se pudo descargar ChromeDriver $CHROMEDRIVER_VERSION."
    echo "Continuando el despliegue sin ChromeDriver, los scrapers que dependen de Selenium no funcionarán."
fi

echo "Instalación de Chrome y ChromeDriver completada (o continuada sin ChromeDriver)."
