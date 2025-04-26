// script.js
// Maneja la interfaz de usuario, autenticación, WebSocket, audio, vuelos, radar y chat para HANDLEPHONE

// Variables globales
let ws; // WebSocket para la comunicación con el servidor
let userId; // Identificador único del usuario (legajo_name_function)
let audioChunks = []; // Almacena fragmentos de audio durante la grabación
let audioContext = new (window.AudioContext || window.webkitAudioContext)(); // Contexto de audio para reproducción
let mediaRecorder; // Objeto para grabar audio
let stream; // Stream de audio del micrófono
let map; // Mapa de Leaflet para el radar
let audioQueue = []; // Cola para reproducir audios en secuencia
let isPlaying = false; // Bandera para evitar superposición de reproducción de audios
let flightData = []; // Almacena datos de vuelos recibidos de /opensky
let markers = []; // Marcadores en el mapa para los vuelos
let recognition; // Objeto para SpeechRecognition (transcripción de voz)
let supportsSpeechRecognition = false; // Bandera para verificar soporte de SpeechRecognition
let mutedUsers = new Set(); // Estado local para rastrear usuarios muteados
let currentGroup = null;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let lastVolumeUpTime = 0;
let volumeUpCount = 0;

// Mapeo de aerolíneas y letras para posibles conversiones
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Inicializar SpeechRecognition y verificar soporte
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    supportsSpeechRecognition = true;
    console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
} else {
    console.error("SpeechRecognition no soportado en este navegador. Navegador:", navigator.userAgent);
    alert("Tu navegador no soporta speech-to-text en el cliente. El servidor transcribirá el audio.");
}

// Función para desbloquear el contexto de audio
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("Contexto de audio desbloqueado");
        }).catch(err => {
            console.error("Error al desbloquear el contexto de audio:", err);
        });
    }
}

// Desbloquear el audio al interactuar con la página
document.addEventListener('click', unlockAudio, { once: true });

// Solicitar permiso para usar el micrófono
async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar permiso de micrófono:", err);
        alert("No se pudo acceder al micrófono. Por favor, habilita los permisos en tu navegador.");
        return null;
    }
}

// Conectar al WebSocket
function connectWebSocket(sessionToken, retryCount = 0, maxRetries = 5) {
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl} (Intento ${retryCount + 1}/${maxRetries})`);
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        alert("Error al intentar conectar con el servidor.");
        return;
    }

    ws.onopen = function() {
        console.log("WebSocket conectado exitosamente");
        ws.send(JSON.stringify({ 
            type: "register", 
            legajo: localStorage.getItem("userLegajo"), 
            name: localStorage.getItem("userName"),
            function: localStorage.getItem("userFunction")
        }));
        showScreen('main');
        updateOpenSkyData();
    };

    ws.onmessage = function(event) {
        console.log("Datos recibidos del servidor:", event.data);
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje parseado:", message);

            if (!message.type) {
                console.error("Mensaje sin tipo:", message);
                return;
            }

            if (message.type === "audio") {
                if (!message.data) {
                    console.error("Mensaje de audio sin datos de audio:", message);
                    return;
                }
                const senderId = `${message.sender}_${message.function}`;
                if (mutedUsers.has(senderId)) {
                    console.log(`Mensaje de ${senderId} ignorado porque está muteado`);
                    return;
                }
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                console.log("Audio Blob creado para reproducción, tamaño:", audioBlob.size, "bytes");
                playAudio(audioBlob);
                const chatList = document.getElementById("chat-list");
                if (!chatList) {
                    console.error("Elemento chat-list no encontrado en el DOM");
                    return;
                }

                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const timestamp = message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = message.sender || "Anónimo";
                const userFunction = message.function || "Desconocida";
                const text = message.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${text}`;
                msgDiv.onclick = () => playAudio(audioBlob);
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
                console.log("Mensaje de audio agregado al chat-list");
            } else if (message.type === "users") {
                updateUsers(message.count, message.list);
            } else if (message.type === "reconnect-websocket") {
                const sessionToken = localStorage.getItem("token");
                if (sessionToken) {
                    connectWebSocket(sessionToken);
                }
                console.log("Intentando reconectar WebSocket...");
            } else if (message.type === "join_group") {
                currentGroup = message.group_id;
                updateSwipeHint();
                console.log(`Unido al grupo: ${message.group_id}`);
                showScreen('group-screen');
            } else if (message.type === "check_group") {
                if (!message.in_group) {
                    currentGroup = null;
                    updateSwipeHint();
                    console.log("No estás en el grupo, currentGroup restablecido a null");
                }
            } else if (message.type === "group_message") {
                const senderId = `${message.sender}_${message.function}`;
                if (mutedUsers.has(senderId)) {
                    console.log(`Mensaje de grupo de ${senderId} ignorado porque está muteado`);
                    return;
                }
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                if (!audioBlob) {
                    console.error("No se pudo crear el Blob para el mensaje de grupo");
                    return;
                }
                playAudio(audioBlob);
                const chatList = document.getElementById("group-chat-list");
                if (!chatList) {
                    console.error("Elemento group-chat-list no encontrado en el DOM");
                    return;
                }
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const timestamp = message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = message.sender || "Anónimo";
                const userFunction = message.function || "Desconocida";
                const text = message.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${text}`;
                msgDiv.onclick = () => playAudio(audioBlob);
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
                console.log("Mensaje de grupo agregado al group-chat-list");
            } else {
                console.warn("Tipo de mensaje desconocido:", message.type);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos recibidos:", event.data);
        }
    };

    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
    };

    ws.onclose = function() {
        console.log("WebSocket cerrado");
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        const talkButton = document.getElementById("talk");
        if (talkButton) {
            talkButton.src = "/templates/mic-off.png";
            talkButton.alt = "Micrófono apagado";
        }
        const sessionToken = localStorage.getItem("token");
        if (sessionToken && retryCount < maxRetries) {
            console.log(`Reintentando conexión WebSocket (intento ${retryCount + 1}/${maxRetries})`);
            setTimeout(() => connectWebSocket(sessionToken, retryCount + 1, maxRetries), 5000);
        } else if (retryCount >= maxRetries) {
            console.error("Máximo número de intentos de reconexión alcanzado");
            localStorage.removeItem("token");
            localStorage.removeItem("userName");
            localStorage.removeItem("userFunction");
            localStorage.removeItem("userLegajo");
            showScreen('login-form');
            alert("No se pudo conectar al servidor después de varios intentos. Por favor, inicia sesión nuevamente.");
        }
    };
}

// Mostrar pantallas
function showScreen(screenId) {
    console.log(`Mostrando pantalla: ${screenId}`);
    const screens = ['intro-screen', 'login-form', 'register-form', 'main', 'group-screen', 'radar-screen', 'history-screen', 'flight-details-modal'];
    screens.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.style.display = id === screenId ? 'block' : 'none';
            console.log(`Pantalla ${id}: ${id === screenId ? 'mostrada' : 'oculta'}`);
        } else {
            console.warn(`Elemento #${id} no encontrado en el DOM`);
        }
    });

    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.style.display = screenId === 'main' || screenId === 'group-screen' ? 'block' : 'none';
        console.log(`Botón de logout: ${logoutButton.style.display}`);
    } else {
        console.warn("Elemento #logout-button no encontrado en el DOM");
    }

    if (screenId === 'main' || screenId === 'group-screen') {
        console.log("Actualizando datos de vuelos para pantalla:", screenId);
        updateOpenSkyData();
    }

    if (screenId === 'radar-screen' && map) {
        console.log("Invalidando tamaño del mapa para radar-screen");
        map.invalidateSize();
    }

    console.log("Actualizando indicación de deslizamiento");
    updateSwipeHint();
}

// Manejo de la pantalla de introducción
window.onload = function() {
    console.log("window.onload ejecutado");

    // Mostrar la pantalla de introducción
    showScreen('intro-screen');

    // Verificar si los elementos de introducción existen
    const introVideo = document.getElementById('intro-video');
    const airplaneIcon = document.getElementById('airplane-icon');
    const loadingBar = document.getElementById('loading-bar');
    const loadingPercentage = document.getElementById('loading-percentage');

    if (!introVideo || !airplaneIcon || !loadingBar || !loadingPercentage) {
        console.warn("Uno o más elementos de introducción no encontrados. Saltando a login-form.");
        setTimeout(checkSessionAndShowScreen, 1000); // Mostrar login-form después de 1 segundo
        return;
    }

    // Iniciar animación de la barra y el avión
    setTimeout(() => {
        console.log("Iniciando animación de barra y avión");
        loadingBar.classList.add('loading');
        airplaneIcon.classList.add('loading');
    }, 100);

    // Animar el porcentaje de 0% a 100% en 10 segundos
    let percentage = 0;
    const interval = setInterval(() => {
        percentage += 1;
        if (percentage <= 100) {
            console.log(`Actualizando porcentaje a ${percentage}%`);
            loadingPercentage.textContent = `${percentage}%`;
        } else {
            console.log("Porcentaje completado, limpiando intervalo");
            clearInterval(interval);
        }
    }, 100); // 10000ms / 100 pasos = 100ms por paso

    // Reproducir el video
    try {
        introVideo.play().catch(err => {
            console.error("Error al reproducir el video:", err);
            // Continuar con la animación aunque el video falle
        });
    } catch (err) {
        console.error("Error al intentar reproducir el video:", err);
    }

    // Cambiar a la pantalla de login después de 10 segundos
    setTimeout(() => {
        console.log("Finalizando introducción, verificando sesión");
        try {
            introVideo.pause();
        } catch (err) {
            console.warn("No se pudo pausar el video:", err);
        }
        loadingBar.classList.remove('loading');
        airplaneIcon.classList.remove('loading');
        loadingPercentage.textContent = '100%';
        clearInterval(interval);
        checkSessionAndShowScreen();
    }, 10000);

    // Verificar la sesión
    function checkSessionAndShowScreen() {
        const sessionToken = localStorage.getItem("token");
        const userName = localStorage.getItem("userName");
        const userFunction = localStorage.getItem("userFunction");
        const userLegajo = localStorage.getItem("userLegajo");

        if (sessionToken && userName && userFunction && userLegajo) {
            console.log("Sesión encontrada en localStorage, intentando conectar WebSocket");
            userId = `${userLegajo}_${userName}_${userFunction}`;
            connectWebSocket(sessionToken);
        } else {
            console.log("No hay sesión válida, mostrando login-form");
            showScreen('login-form');
        }
    }
};

// Manejo de doble toque en el botón de volumen (+) para activar la grabación
document.addEventListener('keydown', (event) => {
    if (event.key === 'VolumeUp') {
        event.preventDefault();
        const currentTime = Date.now();
        const timeDiff = currentTime - lastVolumeUpTime;

        if (timeDiff < 500) {
            volumeUpCount++;
            if (volumeUpCount === 2) {
                toggleTalk();
                volumeUpCount = 0;
            }
        } else {
            volumeUpCount = 1;
        }
        lastVolumeUpTime = currentTime;
    }
});

// Reproducir audio recibido
function playAudio(blob) {
    const audio = new Audio(URL.createObjectURL(blob));
    audioQueue.push(audio);
    playNextAudio();

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaSessionMetadata({
            title: 'Mensaje de voz',
            artist: 'HANDLEPHONE',
            album: 'Comunicación Aeronáutica'
        });

        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    }
}

function muteAll() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "mute_all",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        }));
    } else {
        alert("No estás conectado al servidor.");
    }
}

function unmuteAll() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "unmute_all",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        }));
    } else {
        alert("No estás conectado al servidor.");
    }
}

// Reproducir el siguiente audio en la cola
function playNextAudio() {
    if (audioQueue.length === 0 || isPlaying) return;
    isPlaying = true;
    const audio = audioQueue.shift();
    audio.play().then(() => {
        console.log("Audio reproducido exitosamente");
        isPlaying = false;
        playNextAudio();
    }).catch(err => {
        console.error("Error reproduciendo audio:", err);
        isPlaying = false;
        playNextAudio();
    });
}

// Inicializar el mapa de Leaflet para el radar
function initMap() {
    console.log("Inicializando mapa Leaflet...");
    const mapElement = document.getElementById('map');
    if (!mapElement) {
        console.warn("Elemento #map no encontrado");
        return;
    }
    try {
        if (map) {
            map.remove(); // Limpiar mapa existente
        }
        map = L.map('map').setView([-34.5597, -58.4116], 8); // Centro en Buenos Aires
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(map);

        var airplaneIcon = L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30],
        });

        L.marker([-34.5597, -58.4116], { icon: airplaneIcon })
            .addTo(map)
            .bindPopup("Aeroparque")
            .openPopup();
        console.log("Mapa inicializado correctamente");
    } catch (err) {
        console.error("Error al inicializar mapa:", err);
    }
}

// Calcular la distancia entre dos puntos (en millas náuticas)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.07;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Estimar la hora de llegada basada en la distancia y velocidad
function estimateArrivalTime(lat, lon, speed) {
    const aeroparqueLat = -34.5597;
    const aeroparqueLon = -58.4116;
    const distance = calculateDistance(lat, lon, aeroparqueLat, aeroparqueLon);
    if (!speed || speed <= 0) return "N/A";
    const timeHours = distance / speed;
    const now = new Date();
    const arrivalTime = new Date(now.getTime() + timeHours * 60 * 60 * 1000);
    return arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase().replace(":", "");
}

// Determinar el estado del vuelo
function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "En zona";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

// Filtrar vuelos en el radar según la búsqueda
function filterFlights() {
    const searchTerm = document.getElementById("search-bar").value.toUpperCase();
    markers.forEach(marker => {
        const flight = marker.flight;
        const registration = marker.registration;
        const flightNumber = flight.replace("ARG", "").replace("AR", "");
        const displayFlight = `AEP${flightNumber}`;
        const matchesSearch = 
            registration.toUpperCase().includes(searchTerm) || 
            displayFlight.toUpperCase().includes(searchTerm) ||
            flightNumber === searchTerm;
        if (matchesSearch) {
            if (!map.hasLayer(marker)) {
                marker.addTo(map);
            }
        } else {
            if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        }
    });

    const modalTableBody = document.querySelector('#modal-flight-table tbody');
    if (modalTableBody) {
        const rows = modalTableBody.getElementsByTagName('tr');
        flightData.forEach((flight, index) => {
            const flightNumber = flight.flight_number.replace("ARG", "").replace("AR", "");
            const displayFlight = `AEP${flightNumber}`;
            const matches = 
                flight.registration.toUpperCase().includes(searchTerm) || 
                displayFlight.toUpperCase().includes(searchTerm) ||
                flightNumber === searchTerm;
            if (rows[index]) {
                rows[index].style.display = matches ? '' : 'none';
            }
        });
    }
}

// Actualizar datos de vuelos desde /opensky
function updateOpenSkyData() {
    console.log("Actualizando datos de /opensky...");
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            console.log("Datos recibidos de /opensky:", data);
            flightData = data;
            markers = [];

            // Actualizar flight-details y group-flight-details
            const flightDetails = document.getElementById("flight-details");
            const groupFlightDetails = document.getElementById("group-flight-details");
            if (!flightDetails || !groupFlightDetails) {
                console.error("Elementos #flight-details o #group-flight-details no encontrados en el DOM");
                return;
            }
            flightDetails.innerHTML = "";
            groupFlightDetails.innerHTML = "";

            // Actualizar tabla del modal
            const modalTableBody = document.querySelector('#modal-flight-table tbody');
            if (modalTableBody) {
                modalTableBody.innerHTML = "";
            }

            // Limpiar marcadores del mapa (excepto Aeroparque)
            if (map) {
                map.eachLayer(layer => {
                    if (layer instanceof L.Marker && layer.getPopup().getContent() !== "Aeroparque") {
                        map.removeLayer(layer);
                    }
                });
            }

            if (data.error || !Array.isArray(data)) {
                console.warn("Error en datos de vuelos:", data.error || "Datos no válidos");
                flightDetails.textContent = "Esperando datos de vuelos...";
                groupFlightDetails.textContent = "Esperando datos de vuelos...";
                if (modalTableBody) {
                    modalTableBody.innerHTML = "<tr><td colspan='7'>Esperando datos de vuelos...</td></tr>";
                }
            } else {
                data.forEach(state => {
                    const flight = state.flight_number ? state.flight_number.trim() : 'N/A';
                    const registration = state.registration || "LV-XXX";
                    const scheduled = state.scheduled_time || "N/A";
                    const origin = state.origin || "N/A";
                    const destination = state.destination || "N/A";
                    const status = state.status || getFlightStatus(state.alt_geom || 0, state.gs || 0, state.vert_rate || 0);
                    const source = state.source || "Desconocida";
                    const lat = state.lat;
                    const lon = state.lon;

                    if (flight.startsWith("AR") || flight.startsWith("ARG")) {
                        const flightNumber = flight.replace("ARG", "").replace("AR", "");
                        const displayFlight = `AEP${flightNumber}`;

                        // Añadir a flight-details y group-flight-details
                        const flightDiv = document.createElement("div");
                        flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
                        flightDiv.innerHTML = `
                            <strong>Vuelo:</strong> ${displayFlight} | 
                            <strong>STD:</strong> ${scheduled} | 
                            <strong>Origen:</strong> ${origin} | 
                            <strong>Destino:</strong> ${destination} | 
                            <strong>Matrícula:</strong> ${registration} | 
                            <strong>Estado:</strong> ${status}
                        `;
                        flightDetails.appendChild(flightDiv);
                        groupFlightDetails.appendChild(flightDiv.cloneNode(true));

                        // Añadir a la tabla del modal
                        if (modalTableBody) {
                            const row = document.createElement("tr");
                            row.innerHTML = `
                                <td>${displayFlight}</td>
                                <td>${registration}</td>
                                <td>${scheduled}</td>
                                <td>${origin}</td>
                                <td>${destination}</td>
                                <td>${status}</td>
                                <td>${source}</td>
                            `;
                            modalTableBody.appendChild(row);
                        }

                        // Añadir marcador al mapa
                        if (lat && lon && map) {
                            const marker = L.marker([lat, lon], {
                                icon: L.icon({
                                    iconUrl: '/templates/aero.png',
                                    iconSize: [30, 30]
                                })
                            }).addTo(map)
                              .bindPopup(`
                                  Vuelo: ${displayFlight} (${registration})<br>
                                  Origen: ${origin}<br>
                                  Destino: ${destination}<br>
                                  Estado: ${status}<br>
                                  Fuente: ${source}
                              `);
                            marker.flight = flight;
                            marker.registration = registration;
                            markers.push(marker);
                        }
                    }
                });
                flightDetails.scrollTop = flightDetails.scrollHeight;
                groupFlightDetails.scrollTop = groupFlightDetails.scrollHeight;
            }
        })
        .catch(err => {
            console.error("Error al cargar datos de vuelos:", err);
            const flightDetails = document.getElementById("flight-details");
            const groupFlightDetails = document.getElementById("group-flight-details");
            const modalTableBody = document.querySelector('#modal-flight-table tbody');
            if (flightDetails) {
                flightDetails.textContent = "Error al conectar con el servidor de vuelos";
            }
            if (groupFlightDetails) {
                groupFlightDetails.textContent = "Error al conectar con el servidor de vuelos";
            }
            if (modalTableBody) {
                modalTableBody.innerHTML = "<tr><td colspan='7'>Error al conectar con el servidor de vuelos</td></tr>";
            }
        });
    setTimeout(updateOpenSkyData, 15000);
}

// Mostrar modal de detalles de vuelos
function showFlightDetails() {
    showScreen('flight-details-modal');
    updateOpenSkyData();
}

// Alternar la grabación de audio
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!talkButton) {
        console.error("Botón de hablar no encontrado en el DOM");
        return;
    }

    // Si no estamos grabando o el grabador está inactivo
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("Iniciando grabación...");
        stream = await requestMicPermission();
        if (!stream) {
            console.error("No se pudo obtener el stream del micrófono");
            alert("No se pudo acceder al micrófono. Por favor, verifica los permisos.");
            return;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            console.log("MediaRecorder creado con mimeType: audio/webm");
        } catch (err) {
            console.error("Error al crear MediaRecorder:", err);
            alert("Error al iniciar la grabación: " + err.message);
            return;
        }

        audioChunks = [];
        let transcript = supportsSpeechRecognition ? "" : "Pendiente de transcripción";

        // Configurar SpeechRecognition si está soportado
        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    transcript += event.results[i][0].transcript;
                }
                console.log("Transcripción parcial:", transcript);
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción: " + event.error;
                alert("Error en speech-to-text: " + event.error);
            };
            try {
                recognition.start();
                console.log("SpeechRecognition iniciado");
            } catch (err) {
                console.error("Error al iniciar SpeechRecognition:", err);
            }
        }

        // Manejar datos de audio
        mediaRecorder.ondataavailable = function(event) {
            console.log("Datos de audio disponibles:", event.data.size, "bytes");
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            } else {
                console.warn("Fragmento de audio vacío recibido");
            }
        };

        // Manejar detención de la grabación
        mediaRecorder.onstop = function() {
            console.log("Grabación detenida");
            console.log("Tamaño de audioChunks:", audioChunks.length);
            if (audioChunks.length === 0) {
                console.error("No se capturaron fragmentos de audio");
                alert("No se grabó ningún audio. Verifica tu micrófono.");
                return;
            }

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            console.log("Audio Blob creado, tamaño:", audioBlob.size, "bytes");
            if (audioBlob.size === 0) {
                console.error("Audio Blob vacío");
                alert("El audio grabado está vacío. Verifica tu micrófono.");
                return;
            }

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = function() {
                const base64data = reader.result.split(',')[1];
                console.log("Audio convertido a Base64, longitud:", base64data.length);
                if (!base64data || base64data.length < 100) {
                    console.error("Datos de audio inválidos o demasiado pequeños");
                    alert("El audio grabado es inválido. Por favor, intenta de nuevo.");
                    return;
                }
                const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = localStorage.getItem("userName") || "Anónimo";
                const userFunction = localStorage.getItem("userFunction") || "Desconocida";

                if (ws && ws.readyState === WebSocket.OPEN) {
                    const message = {
                        type: "audio",
                        data: base64data,
                        text: transcript,
                        timestamp: timestamp,
                        sender: sender,
                        function: userFunction
                    };
                    console.log("Enviando mensaje al servidor:", {
                        type: message.type,
                        data: message.data.slice(0, 20) + "...",
                        text: message.text,
                        timestamp: message.timestamp,
                        sender: message.sender,
                        function: message.function
                    });
                    ws.send(JSON.stringify(message));
                } else {
                    console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
                    alert("No se pudo enviar el mensaje: WebSocket no está conectado.");
                    // Encolar para sincronización offline
                    navigator.serviceWorker.controller?.postMessage({
                        type: 'QUEUE_MESSAGE',
                        message: { type: 'audio', data: base64data, text: transcript, timestamp, sender, function: userFunction }
                    });
                }

                const chatList = document.getElementById("chat-list");
                if (chatList) {
                    const msgDiv = document.createElement("div");
                    msgDiv.className = "chat-message";
                    msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${transcript}`;
                    msgDiv.onclick = () => playAudio(audioBlob);
                    chatList.appendChild(msgDiv);
                    chatList.scrollTop = chatList.scrollHeight;
                } else {
                    console.error("Elemento #chat-list no encontrado en el DOM");
                }
            };
            reader.onerror = function(err) {
                console.error("Error al leer el audio como Base64:", err);
                alert("Error al procesar el audio: " + err.message);
            };

            // Limpiar recursos
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) {
                recognition.stop();
            }

            // Cambiar la imagen del botón a "mic-off.png"
            talkButton.src = "/templates/mic-off.png";
            talkButton.alt = "Micrófono apagado";
        };

        mediaRecorder.onerror = function(err) {
            console.error("Error en MediaRecorder:", err);
            alert("Error durante la grabación: " + err.message);
            talkButton.src = "/templates/mic-off.png";
            talkButton.alt = "Micrófono apagado";
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            mediaRecorder = null;
        };

        try {
            mediaRecorder.start(100); // Capturar datos cada 100ms
            console.log("Grabación iniciada");
            talkButton.src = "/templates/mic-on.png";
            talkButton.alt = "Micrófono encendido";
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            alert("Error al iniciar la grabación: " + err.message);
            talkButton.src = "/templates/mic-off.png";
            talkButton.alt = "Micrófono apagado";
        }
    } else if (mediaRecorder.state === "recording") {
        console.log("Deteniendo grabación...");
        mediaRecorder.stop();
                    }
    }

// Alternar el estado de muteo global
function toggleMute() {
    const muteButton = document.getElementById("mute");
    if (muteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute" }));
        }
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute" }));
        }
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
    }
}

// Alternar el muteo de un usuario específico
function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} desmuteado`);
    } else {
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} muteado`);
    }
}

function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) {
        console.error("Elementos #users o #group-users no encontrados en el DOM");
        return;
    }
    usersDiv.innerHTML = `Usuarios conectados: ${count}<br>`;
    groupUsersDiv.innerHTML = `Usuarios conectados: ${list.filter(user => user.group_id === currentGroup).length}<br>`;
    const userList = document.createElement("div");
    userList.className = "user-list";
    const groupUserList = document.createElement("div");
    groupUserList.className = "user-list";

    list.forEach(user => {
        const userDiv = document.createElement("div");
        userDiv.className = "user-item";
        if (user.group_id && user.group_id === currentGroup) {
            userDiv.classList.add('in-group');
        }
        const muteButton = document.createElement("button");
        muteButton.className = "mute-button";
        const isMuted = mutedUsers.has(user.user_id);
        muteButton.textContent = isMuted ? "🔇" : "🔊";
        muteButton.onclick = () => toggleMuteUser(user.user_id, muteButton);
        userDiv.appendChild(muteButton);
        const userText = document.createElement("span");
        let displayText = user.display;
        if (!displayText || displayText === user.user_id) {
            const parts = user.user_id.split('_');
            if (parts.length === 3) {
                const [, name, userFunction] = parts;
                displayText = `${name} (${userFunction})`;
            } else {
                displayText = user.user_id;
            }
        }
        userText.textContent = displayText;
        userDiv.appendChild(userText);
        userList.appendChild(userDiv);

        if (user.group_id === currentGroup) {
            const groupUserDiv = document.createElement("div");
            groupUserDiv.className = "user-item";
            const groupMuteButton = document.createElement("button");
            groupMuteButton.className = "mute-button";
            groupMuteButton.textContent = isMuted ? "🔇" : "🔊";
            groupMuteButton.onclick = () => toggleMuteUser(user.user_id, groupMuteButton);
            groupUserDiv.appendChild(groupMuteButton);
            const groupUserText = document.createElement("span");
            groupUserText.textContent = displayText;
            groupUserDiv.appendChild(groupUserText);
            groupUserList.appendChild(groupUserDiv);
        }
    });

    usersDiv.appendChild(userList);
    groupUsersDiv.appendChild(groupUserList);
    console.log("Lista de usuarios actualizada:", list);
}

// Función para unirse a un grupo
function joinGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupId }));
        currentGroup = groupId;
        showScreen('group-screen');
        updateSwipeHint();
    } else {
        alert('No estás conectado al servidor. Por favor, intenta de nuevo.');
    }
}

// Función para salir de un grupo
function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        showScreen('main');
        document.getElementById('group-chat-list').innerHTML = '';
        document.getElementById('group-flight-details').innerHTML = '';
        updateSwipeHint();
    }
}

// Función para verificar el estado del grupo
function checkGroupStatus() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'check_group', group_id: currentGroup }));
    }
}

// Función para actualizar el botón "Volver al Grupo" y el texto de indicación
function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (swipeHint && returnToGroupBtn) {
        if (currentGroup) {
            swipeHint.style.display = 'block';
            returnToGroupBtn.style.display = 'block';
        } else {
            swipeHint.style.display = 'none';
            returnToGroupBtn.style.display = 'none';
        }
    } else {
        console.warn("Elementos #swipe-hint o #return-to-group-btn no encontrados en el DOM");
    }
}

// Función para regresar al grupo desde la pantalla principal
function returnToGroup() {
    if (currentGroup) {
        const mainScreen = document.getElementById('main');
        if (mainScreen) {
            mainScreen.classList.add('slide-left');
            setTimeout(() => {
                showScreen('group-screen');
                mainScreen.classList.remove('slide-left');
            }, 300);
        } else {
            console.warn("Elemento #main no encontrado en el DOM");
            showScreen('group-screen');
        }
    }
}

// Función para volver a la pantalla principal desde el grupo
function backToMainFromGroup() {
    const groupScreen = document.getElementById('group-screen');
    if (groupScreen) {
        groupScreen.classList.add('slide-right');
        setTimeout(() => {
            showScreen('main');
            groupScreen.classList.remove('slide-right');
            checkGroupStatus();
        }, 300);
    } else {
        console.warn("Elemento #group-screen no encontrado en el DOM");
        showScreen('main');
        checkGroupStatus();
    }
}

// Funciones para manejar mensajes de voz en el grupo
let groupRecording = false;
let groupMediaRecorder = null;

function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) {
        console.error("Botón #group-talk no encontrado en el DOM");
        return;
    }

    if (!groupRecording) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                groupMediaRecorder = new MediaRecorder(stream);
                const chunks = [];
                groupMediaRecorder.ondataavailable = e => chunks.push(e.data);
                groupMediaRecorder.onstop = () => {
                    const blob = new Blob(chunks, { type: 'audio/webm' });
                    const reader = new FileReader();
                    reader.onload = () => {
                        const audioData = reader.result.split(',')[1];
                        sendGroupMessage(audioData);
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach(track => track.stop());
                };
                groupMediaRecorder.start();
                groupRecording = true;
                talkButton.style.backgroundColor = '#32CD32';
                console.log("Grabación de grupo iniciada");
            })
            .catch(err => {
                console.error('Error al acceder al micrófono:', err);
                alert('No se pudo acceder al micrófono. Por favor, verifica los permisos.');
            });
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.style.backgroundColor = '#FF4500';
        console.log("Grabación de grupo detenida");
    }
}

function toggleGroupMute() {
    const muteButton = document.getElementById('group-mute');
    if (!muteButton) {
        console.error("Elemento #group-mute no encontrado en el DOM");
        return;
    }
    if (muteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute" }));
        }
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute" }));
        }
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
    }
}

function sendGroupMessage(audioData) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        ws.send(JSON.stringify({
            type: 'group_message',
            data: audioData,
            sender: localStorage.getItem('userName'),
            function: localStorage.getItem('userFunction'),
            timestamp: timestamp,
            text: 'Pendiente de transcripción'
        }));
        console.log("Mensaje de grupo enviado");
    } else {
        console.error("WebSocket no está abierto. Encolando mensaje de grupo para sincronización offline");
        navigator.serviceWorker.controller?.postMessage({
            type: 'QUEUE_MESSAGE',
            message: {
                type: 'group_message',
                data: audioData,
                sender: localStorage.getItem('userName'),
                function: localStorage.getItem('userFunction'),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                text: 'Pendiente de transcripción'
            }
        });
    }
}

// Funciones para mostrar radar e historial desde el grupo
function showGroupRadar() {
    showScreen('radar-screen');
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function showGroupHistory() {
    showScreen('history-screen');
    loadHistory();
}

// Event listeners para gestos de deslizamiento
document.addEventListener('touchstart', e => {
    if (!isSwiping) {
        startX = e.touches[0].clientX;
        isSwiping = true;
    }
});

document.addEventListener('touchmove', e => {
    if (isSwiping) {
        currentX = e.touches[0].clientX;
    }
});

document.addEventListener('touchend', e => {
    if (!isSwiping) return;
    const deltaX = currentX - startX;
    if (Math.abs(deltaX) > 50) {
        if (deltaX > 0 && document.getElementById('group-screen')?.style.display === 'block') {
            backToMainFromGroup();
        } else if (deltaX < 0 && document.getElementById('main')?.style.display === 'block' && currentGroup) {
            returnToGroup();
        }
    }
    isSwiping = false;
});

// Cerrar sesión
function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
        ws.close();
    }
    localStorage.removeItem("token");
    localStorage.removeItem("userName");
    localStorage.removeItem("userFunction");
    localStorage.removeItem("userLegajo");
    showScreen("login-form");
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    userId = null;
    currentGroup = null;
    audioChunks = [];
    audioQueue = [];
    isPlaying = false;
    flightData = [];
    markers = [];
    console.log("Sesión cerrada");
}

// Mostrar la pantalla del radar
function showRadar() {
    showScreen("radar-screen");
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

// Volver a la pantalla principal desde el radar
function backToMainFromRadar() {
    showScreen("main");
    const searchBar = document.getElementById("search-bar");
    if (searchBar) {
        searchBar.value = "";
        filterFlights();
    }
}

// Mostrar el historial de mensajes
function showHistory() {
    fetch('/history')
        .then(response => response.json())
        .then(data => {
            const historyList = document.getElementById("history-list");
            if (!historyList) {
                console.error("Elemento #history-list no encontrado en el DOM");
                return;
            }
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = msg.timestamp.split(":");
                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${msg.text}`;
                const audio = new Audio(`data:audio/webm;base64,${msg.audio}`);
                msgDiv.onclick = () => playAudio(new Blob([base64ToBlob(msg.audio, 'audio/webm')]));
                historyList.appendChild(msgDiv);
            });
            showScreen("history-screen");
        })
        .catch(err => {
            console.error("Error al cargar historial:", err);
            const historyList = document.getElementById("history-list");
            if (historyList) {
                historyList.textContent = "Error al cargar historial";
            }
        });
}

// Cargar historial (para consistencia con showGroupHistory)
function loadHistory() {
    showHistory();
}

// Convertir Base64 a Blob para audio
function base64ToBlob(base64, mime) {
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([uint8Array], { type: mime });
    } catch (err) {
        console.error("Error al convertir Base64 a Blob:", err);
        return null;
    }
}

// Registro del Service Worker para PWA
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        // Intentar registrar en la raíz primero
        fetch('/sw.js', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    navigator.serviceWorker.register('/sw.js', { scope: '/' })
                        .then(reg => {
                            console.log('Service Worker registrado en /:', reg);
                        })
                        .catch(err => {
                            console.error('Error al registrar Service Worker en /:', err);
                            // Fallback a /templates/sw.js
                            fetch('/templates/sw.js', { method: 'HEAD' })
                                .then(response => {
                                    if (response.ok) {
                                        navigator.serviceWorker.register('/templates/sw.js')
                                            .then(reg => {
                                                console.log('Service Worker registrado en /templates:', reg);
                                            })
                                            .catch(err => console.error('Error al registrar Service Worker en /templates:', err));
                                    } else {
                                        console.warn('Archivo /templates/sw.js no encontrado');
                                    }
                                })
                                .catch(err => console.warn('No se pudo verificar /templates/sw.js:', err));
                        });
                } else {
                    console.warn('Archivo /sw.js no encontrado, intentando /templates/sw.js');
                    fetch('/templates/sw.js', { method: 'HEAD' })
                        .then(response => {
                            if (response.ok) {
                                navigator.serviceWorker.register('/templates/sw.js')
                                    .then(reg => {
                                        console.log('Service Worker registrado en /templates:', reg);
                                    })
                                    .catch(err => console.error('Error al registrar Service Worker en /templates:', err));
                            } else {
                                console.warn('Archivo /templates/sw.js no encontrado');
                            }
                        })
                        .catch(err => console.warn('No se pudo verificar /templates/sw.js:', err));
                }
            })
            .catch(err => {
                console.warn('No se pudo verificar /sw.js:', err);
                // Fallback a /templates/sw.js
                fetch('/templates/sw.js', { method: 'HEAD' })
                    .then(response => {
                        if (response.ok) {
                            navigator.serviceWorker.register('/templates/sw.js')
                                .then(reg => {
                                    console.log('Service Worker registrado en /templates:', reg);
                                })
                                .catch(err => console.error('Error al registrar Service Worker en /templates:', err));
                        } else {
                            console.warn('Archivo /templates/sw.js no encontrado');
                        }
                    })
                    .catch(err => console.warn('No se pudo verificar /templates/sw.js:', err));
            });
    } else {
        console.warn('Service Worker no soportado.');
    }
}

// Verificar permisos de notificación
function checkNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            console.log('Permiso de notificación concedido');
            subscribeToPush();
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Permiso de notificación concedido');
                    subscribeToPush();
                } else {
                    console.warn('Permiso de notificación denegado');
                }
            }).catch(err => {
                console.error('Error al solicitar permiso de notificación:', err);
            });
        } else {
            console.warn('Permiso de notificación denegado previamente');
        }
    } else {
        console.warn('Notificaciones no soportadas');
    }
}

function urlBase64ToUint8Array(base64String) {
    try {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    } catch (err) {
        console.error("Error al convertir Base64 a Uint8Array:", err);
        throw err;
    }
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM completamente cargado, inicializando...");
    registerServiceWorker();
    checkNotificationPermission();

    // Formulario de registro
    const registerForm = document.getElementById('register-form-form');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            console.log("Enviando formulario de registro...");
            const surname = document.getElementById('surname').value;
            const employee_id = document.getElementById('employee_id').value;
            const sector = document.getElementById('sector').value;
            const password = document.getElementById('password').value;
            const errorElement = document.getElementById('register-error');

            if (!/^\d{5}$/.test(employee_id)) {
                errorElement.textContent = 'El legajo debe contener 5 números.';
                console.warn("Validación fallida: legajo inválido");
                return;
            }
            if (password.length < 6) {
                errorElement.textContent = 'La contraseña debe tener al menos 6 caracteres.';
                console.warn("Validación fallida: contraseña demasiado corta");
                return;
            }

            try {
                const response = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surname, employee_id, sector, password })
                });
                const data = await response.json();
                if (response.ok) {
                    console.log("Registro exitoso:", data);
                    alert('Registro exitoso. Inicia sesión.');
                    showScreen('login-form');
                } else {
                    console.error("Error al registrarse:", data.detail);
                    errorElement.textContent = data.detail || 'Error al registrarse';
                }
            } catch (error) {
                console.error("Error al conectar con el servidor:", error);
                errorElement.textContent = 'Error al conectar con el servidor';
            }
        });
    } else {
        console.warn("Elemento #register-form-form no encontrado en el DOM");
    }

    // Formulario de inicio de sesión
    const loginForm = document.getElementById('login-form-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            console.log("Enviando formulario de inicio de sesión...");
            const surname = document.getElementById('surname').value;
            const employee_id = document.getElementById('employee_id').value;
            const password = document.getElementById('password').value;
            const errorElement = document.getElementById('login-error');

            if (!/^\d{5}$/.test(employee_id)) {
                errorElement.textContent = 'El legajo debe contener 5 números.';
                console.warn("Validación fallida: legajo inválido");
                return;
            }

            try {
                const response = await fetch('/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ surname, employee_id, password })
                });
                const data = await response.json();
                if (response.ok) {
                    console.log("Inicio de sesión exitoso:", data);
                    const token = data.token;
                    const [legajo, name, sector] = atob(token).split('_');
                    userId = `${legajo}_${name}_${sector}`;
                    localStorage.setItem('token', token);
                    localStorage.setItem('userName', name);
                    localStorage.setItem('userFunction', sector);
                    localStorage.setItem('userLegajo', legajo);
                    connectWebSocket(token);
                    showScreen('main');
                    checkGroupStatus();
                } else {
                    console.error("Error al iniciar sesión:", data.detail);
                    errorElement.textContent = data.detail || 'Error al iniciar sesión';
                }
            } catch (error) {
                console.error("Error al conectar con el servidor:", error);
                errorElement.textContent = 'Error al conectar con el servidor';
            }
        });
    } else {
        console.warn("Elemento #login-form-form no encontrado en el DOM");
    }

    // Event listeners para botones y elementos interactivos
    const showRegister = document.getElementById('show-register');
    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            console.log("Mostrando formulario de registro");
            showScreen('register-form');
        });
    } else {
        console.warn("Elemento #show-register no encontrado en el DOM");
    }

    const showLogin = document.getElementById('show-login');
    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            console.log("Mostrando formulario de inicio de sesión");
            showScreen('login-form');
        });
    } else {
        console.warn("Elemento #show-login no encontrado en el DOM");
    }

    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    } else {
        console.warn("Elemento #logout-button no encontrado en el DOM");
    }

    const joinGroupBtn = document.getElementById('join-group-btn');
    if (joinGroupBtn) {
        joinGroupBtn.addEventListener('click', joinGroup);
    } else {
        console.warn("Elemento #join-group-btn no encontrado en el DOM");
    }

    const leaveGroupBtn = document.getElementById('leave-group-btn');
    if (leaveGroupBtn) {
        leaveGroupBtn.addEventListener('click', leaveGroup);
    } else {
        console.warn("Elemento #leave-group-btn no encontrado en el DOM");
    }

    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (returnToGroupBtn) {
        returnToGroupBtn.addEventListener('click', returnToGroup);
    } else {
        console.warn("Elemento #return-to-group-btn no encontrado en el DOM");
    }

    const radarBtn = document.getElementById('radar');
    if (radarBtn) {
        radarBtn.addEventListener('click', showRadar);
    } else {
        console.warn("Elemento #radar no encontrado en el DOM");
    }

    const historyBtn = document.getElementById('history');
    if (historyBtn) {
        historyBtn.addEventListener('click', showHistory);
    } else {
        console.warn("Elemento #history no encontrado en el DOM");
    }

    const groupRadarBtn = document.getElementById('group-radar');
    if (groupRadarBtn) {
        groupRadarBtn.addEventListener('click', showGroupRadar);
    } else {
        console.warn("Elemento #group-radar no encontrado en el DOM");
    }

    const groupHistoryBtn = document.getElementById('group-history');
    if (groupHistoryBtn) {
        groupHistoryBtn.addEventListener('click', showGroupHistory);
    } else {
        console.warn("Elemento #group-history no encontrado en el DOM");
    }

    const backToMainBtn = document.getElementById('back-to-main');
    if (backToMainBtn) {
        backToMainBtn.addEventListener('click', backToMain);
    } else {
        console.warn("Elemento #back-to-main no encontrado en el DOM");
    }

    const talkBtn = document.getElementById('talk');
    if (talkBtn) {
        talkBtn.addEventListener('click', toggleTalk);
    } else {
        console.warn("Elemento #talk no encontrado en el DOM");
    }

    const muteBtn = document.getElementById('mute');
    if (muteBtn) {
        muteBtn.addEventListener('click', toggleMute);
    } else {
        console.warn("Elemento #mute no encontrado en el DOM");
    }

    const groupTalkBtn = document.getElementById('group-talk');
    if (groupTalkBtn) {
        groupTalkBtn.addEventListener('click', toggleGroupTalk);
    } else {
        console.warn("Elemento #group-talk no encontrado en el DOM");
    }

    const groupMuteBtn = document.getElementById('group-mute');
    if (groupMuteBtn) {
        groupMuteBtn.addEventListener('click', toggleGroupMute);
    } else {
        console.warn("Elemento #group-mute no encontrado en el DOM");
    }

    const searchBar = document.getElementById('search-bar');
    if (searchBar) {
        searchBar.addEventListener('input', filterFlights);
    } else {
        console.warn("Elemento #search-bar no encontrado en el DOM");
    }

    const closeBtn = document.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', backToMainFromRadar);
    } else {
        console.warn("Elemento .close-btn no encontrado en el DOM");
    }

    const mainFlightDetailsBtn = document.getElementById('main-flight-details-button');
    if (mainFlightDetailsBtn) {
        mainFlightDetailsBtn.addEventListener('click', showFlightDetails);
    } else {
        console.warn("Elemento #main-flight-details-button no encontrado en el DOM");
    }

    const groupFlightDetailsBtn = document.getElementById('group-flight-details-button');
    if (groupFlightDetailsBtn) {
        groupFlightDetailsBtn.addEventListener('click', showFlightDetails);
    } else {
        console.warn("Elemento #group-flight-details-button no encontrado en el DOM");
    }

    const closeModalBtn = document.getElementById('close-modal');
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            showScreen('main');
            const searchBar = document.getElementById("search-bar");
            if (searchBar) {
                searchBar.value = "";
                filterFlights();
            }
        });
    } else {
        console.warn("Elemento #close-modal no encontrado en el DOM");
    }
});
 
