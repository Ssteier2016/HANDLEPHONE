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
        const sessionToken = localStorage.getItem("token");
        if (sessionToken && retryCount < maxRetries) {
            setTimeout(() => connectWebSocket(sessionToken, retryCount + 1, maxRetries), 5000);
        } else if (retryCount >= maxRetries) {
            console.error("Máximo número de intentos de reconexión alcanzado. Por favor, recarga la página.");
            alert("No se pudo reconectar al servidor después de varios intentos. Por favor, recarga la página.");
            showScreen('login-form');
        }
    };
}

// Mostrar pantallas
function showScreen(screenId) {
    const screens = ['login-form', 'register-form', 'main', 'group-screen', 'radar-screen', 'history-screen'];
    screens.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.style.display = id === screenId ? 'block' : 'none';
    });

    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.style.display = screenId === 'main' || screenId === 'group-screen' ? 'block' : 'none';
    }

    if (screenId === 'main' || screenId === 'group-screen') {
        updateOpenSkyData();
    }

    updateSwipeHint();
}

// Cargar la página y verificar si el usuario ya está autenticado
window.onload = function() {
    console.log("window.onload ejecutado");
    const sessionToken = localStorage.getItem("token");
    console.log("sessionToken:", sessionToken);
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const mainDiv = document.getElementById("main");
    const radarDiv = document.getElementById("radar-screen");
    const historyDiv = document.getElementById("history-screen");

    if (!loginForm || !registerForm || !mainDiv || !radarDiv || !historyDiv) {
        console.error("Uno o más elementos no se encontraron en el DOM:", {
            loginForm: !!loginForm,
            registerForm: !!registerForm,
            mainDiv: !!mainDiv,
            radarDiv: !!radarDiv,
            historyDiv: !!historyDiv
        });
        return;
    }

    if (sessionToken && localStorage.getItem("userName") && localStorage.getItem("userFunction") && localStorage.getItem("userLegajo")) {
        console.log("Usuario autenticado, mostrando pantalla principal");
        userId = `${localStorage.getItem("userLegajo")}_${localStorage.getItem("userName")}_${localStorage.getItem("userFunction")}`;
        connectWebSocket(sessionToken);
        showScreen('main');
        const muteButton = document.getElementById("mute");
        if (muteButton) {
            muteButton.classList.add("unmuted");
        }
    } else {
        console.log("Usuario no autenticado, mostrando pantalla de login");
        showScreen('login-form');
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
    map = L.map('map').setView([-34.5597, -58.4116], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    var airplaneIcon = L.icon({
        iconUrl: 'templates/airport.png',
        iconSize: [30, 30],
    });

    L.marker([-34.5597, -58.4116], { icon: airplaneIcon }).addTo(map)
        .bindPopup("Aeroparque").openPopup();

    const searchBar = document.getElementById("search-bar");
    searchBar.addEventListener("input", filterFlights);
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
}

// Actualizar datos de vuelos desde /opensky
function updateOpenSkyData() {
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            console.log("Datos recibidos de /opensky:", data);
            const flightDetails = document.getElementById("flight-details");
            const groupFlightDetails = document.getElementById("group-flight-details");
            if (!flightDetails || !groupFlightDetails) {
                console.error("Elementos #flight-details o #group-flight-details no encontrados en el DOM");
                return;
            }
            flightDetails.innerHTML = "";
            groupFlightDetails.innerHTML = "";
            flightData = data;
            markers = [];

            if (map) {
                map.eachLayer(layer => {
                    if (layer instanceof L.Marker && layer.getPopup().getContent() !== "Aeroparque") {
                        map.removeLayer(layer);
                    }
                });
            }

            if (data.error) {
                console.warn("Error en Airplanes.Live:", data.error);
                flightDetails.textContent = "Esperando datos de Airplanes.Live...";
                groupFlightDetails.textContent = "Esperando datos de Airplanes.Live...";
            } else {
                data.forEach(state => {
                    const lat = state.lat;
                    const lon = state.lon;
                    const flight = state.flight ? state.flight.trim() : 'N/A';
                    const registration = state.registration || "LV-XXX";
                    const speed = state.gs;
                    const altitude = state.alt_geom || 0;
                    const verticalRate = state.vert_rate || 0;
                    const originDest = state.origin_dest || "N/A";
                    const scheduled = state.scheduled || "N/A";
                    const position = state.position || "N/A";
                    const destination = state.destination || "N/A";
                    const status = state.status || getFlightStatus(altitude, speed, verticalRate);

                    if (flight.startsWith("AR") || flight.startsWith("ARG")) {
                        const flightNumber = flight.replace("ARG", "").replace("AR", "");
                        const displayFlight = `AEP${flightNumber}`;

                        const flightDiv = document.createElement("div");
                        flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
                        flightDiv.innerHTML = `
                            <strong>Vuelo:</strong> ${displayFlight} | 
                            <strong>STD:</strong> ${scheduled} | 
                            <strong>Posición:</strong> ${position} | 
                            <strong>Destino:</strong> ${destination} | 
                            <strong>Matrícula:</strong> ${registration} | 
                            <strong>Estado:</strong> ${status}
                        `;
                        flightDetails.appendChild(flightDiv);
                        groupFlightDetails.appendChild(flightDiv.cloneNode(true));

                        if (lat && lon && map) {
                            const marker = L.marker([lat, lon], { 
                                icon: L.icon({
                                    iconUrl: '/templates/aero.png',
                                    iconSize: [30, 30]
                                })
                            }).addTo(map)
                              .bindPopup(`Vuelo: ${displayFlight} / ${registration}<br>Ruta: ${originDest}<br>Estado: ${status}`);
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
            console.error("Error al cargar datos de Airplanes.Live:", err);
            const flightDetails = document.getElementById("flight-details");
            const groupFlightDetails = document.getElementById("group-flight-details");
            if (flightDetails) {
                flightDetails.textContent = "Error al conectar con Airplanes.Live";
            }
            if (groupFlightDetails) {
                groupFlightDetails.textContent = "Error al conectar con Airplanes.Live";
            }
        });
    setTimeout(updateOpenSkyData, 15000);
}

// Alternar la grabación de audio
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
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

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        transcript += event.results[i][0].transcript;
                    } else {
                        transcript += event.results[i][0].transcript;
                    }
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

        mediaRecorder.ondataavailable = function(event) {
            console.log("Datos de audio disponibles:", event.data.size, "bytes");
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            } else {
                console.warn("Fragmento de audio vacío recibido");
            }
        };
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
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) recognition.stop();
        };
        mediaRecorder.onerror = function(err) {
            console.error("Error en MediaRecorder:", err);
            alert("Error durante la grabación: " + err.message);
        };
        try {
            mediaRecorder.start(100);
            console.log("Grabación iniciada");
            talkButton.textContent = "Grabando...";
            talkButton.style.backgroundColor = "green";
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            alert("Error al iniciar la grabación: " + err.message);
        }
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.textContent = "Hablar";
        talkButton.style.backgroundColor = "red";
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
    if (currentGroup) {
        swipeHint.style.display = 'block';
        returnToGroupBtn.style.display = 'block';
    } else {
        swipeHint.style.display = 'none';
        returnToGroupBtn.style.display = 'none';
    }
}

// Función para regresar al grupo desde la pantalla principal
function returnToGroup() {
    if (currentGroup) {
        document.getElementById('main').classList.add('slide-left');
        setTimeout(() => {
            showScreen('group-screen');
            document.getElementById('main').classList.remove('slide-left');
        }, 300);
    }
}

// Función para volver a la pantalla principal desde el grupo
function backToMainFromGroup() {
    document.getElementById('group-screen').classList.add('slide-right');
    setTimeout(() => {
        showScreen('main');
        document.getElementById('group-screen').classList.remove('slide-right');
        checkGroupStatus();
    }, 300);
}

// Funciones para manejar mensajes de voz en el grupo
let groupRecording = false;
let groupMediaRecorder = null;

function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
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
                };
                groupMediaRecorder.start();
                groupRecording = true;
                talkButton.style.backgroundColor = '#32CD32';
            })
            .catch(err => {
                console.error('Error al acceder al micrófono:', err);
                alert('No se pudo acceder al micrófono. Por favor, verifica los permisos.');
            });
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.style.backgroundColor = '#FF4500';
    }
}

function toggleGroupMute() {
    const muteButton = document.getElementById('group-mute');
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
    }
}

// Funciones para mostrar radar e historial desde el grupo
function showGroupRadar() {
    showScreen('radar-screen');
    initMap();
}

function showGroupHistory() {
    showScreen('history-screen');
    loadHistory();
}

// Event listeners para gestos de deslizamiento
document.addEventListener('touchstart', e => {
    if (!isSwiping) {
        startX = e.touches[0].clientX;
    }
});

document.addEventListener('touchmove', e => {
    if (!isSwiping) {
        currentX = e.touches[0].clientX;
    }
});

document.addEventListener('touchend', e => {
    if (isSwiping) return;
    const deltaX = currentX - startX;
    if (Math.abs(deltaX) > 50) {
        if (deltaX > 0 && document.getElementById('group-screen').style.display === 'block') {
            backToMainFromGroup();
        } else if (deltaX < 0 && document.getElementById('main').style.display === 'block' && currentGroup) {
            returnToGroup();
        }
    }
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
    document.getElementById("search-bar").value = "";
    filterFlights();
}

// Mostrar el historial de mensajes
function showHistory() {
    fetch('/history')
        .then(response => response.json())
        .then(data => {
            const historyList = document.getElementById("history-list");
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
        .catch(err => console.error("Error al cargar historial:", err));
}

// Volver a la pantalla principal desde el historial
function backToMain() {
    showScreen("main");
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
        fetch('/templates/sw.js', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    navigator.serviceWorker.register('/templates/sw.js')
                        .then(() => console.log('Service Worker registrado'))
                        .catch(err => console.error('Error al registrar Service Worker:', err));
                } else {
                    console.warn('Archivo sw.js no encontrado.');
                }
            })
            .catch(err => {
                console.warn('No se pudo verificar sw.js:', err);
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

function subscribeToPush() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array('YOUR_PUBLIC_VAPID_KEY')
            }).then(subscription => {
                console.log("Suscripción a push exitosa:", subscription);
                fetch('/subscribe', {
                    method: 'POST',
                    body: JSON.stringify(subscription),
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }).catch(err => {
                    console.error("Error al enviar suscripción al servidor:", err);
                });
            }).catch(err => {
                console.error("Error al suscribirse a push:", err);
            });
        }).catch(err => {
            console.error("Error al obtener el Service Worker:", err);
        });
    } else {
        console.warn('Notificaciones push no soportadas.');
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
    registerServiceWorker();
    checkNotificationPermission();

    // Formulario de registro
    const registerForm = document.getElementById('register-form-form');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const surname = document.getElementById('surname').value;
            const employee_id = document.getElementById('employee_id').value;
            const sector = document.getElementById('sector').value;
            const password = document.getElementById('password').value;
            const errorElement = document.getElementById('register-error');

            if (!/^\d{5}$/.test(employee_id)) {
                errorElement.textContent = 'El legajo debe contener 5 números.';
                return;
            }
            if (password.length < 6) {
                errorElement.textContent = 'La contraseña debe tener al menos 6 caracteres.';
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
                    alert('Registro exitoso. Inicia sesión.');
                    showScreen('login-form');
                } else {
                    errorElement.textContent = data.detail || 'Error al registrarse';
                }
            } catch (error) {
                errorElement.textContent = 'Error al conectar con el servidor';
            }
        });
    }

    // Formulario de inicio de sesión
    const loginForm = document.getElementById('login-form-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const surname = document.getElementById('surname').value;
            const employee_id = document.getElementById('employee_id').value;
            const password = document.getElementById('password').value;
            const errorElement = document.getElementById('login-error');

            if (!/^\d{5}$/.test(employee_id)) {
                errorElement.textContent = 'El legajo debe contener 5 números.';
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
                    errorElement.textContent = data.detail || 'Error al iniciar sesión';
                }
            } catch (error) {
                errorElement.textContent = 'Error al conectar con el servidor';
            }
        });
    }

    document.getElementById('show-register')?.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen('register-form');
    });

    document.getElementById('show-login')?.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen('login-form');
    });

    document.getElementById('logout-button')?.addEventListener('click', logout);
    document.getElementById('join-group-btn')?.addEventListener('click', joinGroup);
    document.getElementById('leave-group-btn')?.addEventListener('click', leaveGroup);
    document.getElementById('return-to-group-btn')?.addEventListener('click', returnToGroup);
    document.getElementById('radar')?.addEventListener('click', showRadar);
    document.getElementById('history')?.addEventListener('click', showHistory);
    document.getElementById('group-radar')?.addEventListener('click', showGroupRadar);
    document.getElementById('group-history')?.addEventListener('click', showGroupHistory);
    document.getElementById('back-to-main')?.addEventListener('click', backToMain);
    document.getElementById('talk')?.addEventListener('click', toggleTalk);
    document.getElementById('mute')?.addEventListener('click', toggleMute);
    document.getElementById('group-talk')?.addEventListener('click', toggleGroupTalk);
    document.getElementById('group-mute')?.addEventListener('click', toggleGroupMute);
    document.getElementById('search-bar')?.addEventListener('input', filterFlights);
    document.querySelector('.close-btn')?.addEventListener('click', backToMainFromRadar);
});
