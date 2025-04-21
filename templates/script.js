// Constantes
const PING_INTERVAL = 30000; // Ping cada 30 segundos
const RECONNECT_BASE_DELAY = 5000; // Reintento base cada 5 segundos
const SYNC_TAG = 'sync-messages'; // Tag para sincronización
const FLIGHT_UPDATE_INTERVAL = 300000; // 5 minutos
const MAPBOX_TOKEN = 'YOUR_MAPBOX_ACCESS_TOKEN'; // Reemplazar con token válido
const VAPID_PUBLIC_KEY = 'YOUR_PUBLIC_VAPID_KEY'; // Reemplazar con clave VAPID
const WS_URL = `wss://${window.location.host}/ws/`;

// Mapeo de aerolíneas
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "Aeroparque Jorge Newbery"
};

// Variables globales
let ws = null;
let pingInterval = null;
let reconnectInterval = null;
let flightInterval = null;
let userId = null;
let token = null;
let stream = null;
let mediaRecorder = null;
let groupMediaRecorder = null;
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioQueue = [];
let isPlaying = false;
let isRecording = false;
let groupRecording = false;
let map = null;
let markers = [];
let flightPaths = {};
let flightData = [];
let currentGroup = null;
let mutedUsers = new Set();
let recognition = null;
let supportsSpeechRecognition = false;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let lastVolumeUpTime = 0;
let volumeUpCount = 0;

// Inicializar SpeechRecognition
function initSpeechRecognition() {
    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.lang = 'es-ES';
        recognition.continuous = true;
        recognition.interimResults = true;
        supportsSpeechRecognition = true;
        console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
    } else {
        console.warn("SpeechRecognition no soportado. Navegador:", navigator.userAgent);
        alert("Tu navegador no soporta speech-to-text. El servidor transcribirá el audio.");
    }
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
        fetchAEPFlights();
        startFlightUpdates();
    } else {
        stopFlightUpdates();
    }

    updateSwipeHint();
}

// Conexión WebSocket
function connectWebSocket(sessionToken, retryCount = 0) {
    if (retryCount >= 5) {
        alert('No se pudo reconectar al servidor después de varios intentos.');
        completeLogout();
        return;
    }

    const wsUrl = `${WS_URL}${sessionToken}`;
    console.log(`Conectando WebSocket a ${wsUrl} (Intento ${retryCount + 1})`);
    
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        alert("Error al conectar con el servidor.");
        return;
    }

    ws.onopen = () => {
        console.log("WebSocket conectado exitosamente");
        clearInterval(reconnectInterval);
        reconnectInterval = null;

        ws.send(JSON.stringify({
            type: "register",
            legajo: localStorage.getItem("userLegajo"),
            name: localStorage.getItem("userName"),
            function: localStorage.getItem("userFunction")
        }));

        startPing();
        showScreen('main');
        updateUsers(0, []);
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register(SYNC_TAG).catch(err => {
                console.error('Error al registrar sync:', err);
            });
        });
    };

    ws.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje recibido:", message);

            switch (message.type) {
                case 'connection_success':
                    console.log('Conexión WebSocket exitosa:', message.message);
                    break;
                case 'audio':
                case 'group_message':
                    if (!mutedUsers.has(`${message.sender}_${message.function}`)) {
                        const audioBlob = base64ToBlob(message.data, 'audio/webm');
                        if (audioBlob) {
                            audioQueue.push({ blob: audioBlob, message });
                            if (!isPlaying) playNextAudio();
                            appendChatMessage(message, audioBlob);
                        }
                    }
                    break;
                case 'users':
                    updateUsers(message.count, message.list);
                    break;
                case 'flight_update':
                case 'fr24_update':
                case 'opensky_update':
                    flightData = message.flights;
                    localStorage.setItem('flightData', JSON.stringify(flightData));
                    updateFlightTable(flightData);
                    if (message.type === 'opensky_update') updateOpenSkyData(message.flights);
                    break;
                case 'search_response':
                    displaySearchResponse(message.message);
                    break;
                case 'mute_all_success':
                    updateMuteButton(true);
                    break;
                case 'unmute_all_success':
                    updateMuteButton(false);
                    break;
                case 'mute_non_group_success':
                    message.user_ids.forEach(id => mutedUsers.add(id));
                    updateUsers(message.count, message.list);
                    updateMuteNonGroupButton(true);
                    break;
                case 'unmute_non_group_success':
                    message.user_ids.forEach(id => mutedUsers.delete(id));
                    updateUsers(message.count, message.list);
                    updateMuteNonGroupButton(false);
                    break;
                case 'group_joined':
                case 'create_group_success':
                    currentGroup = message.group_id;
                    localStorage.setItem('groupId', currentGroup);
                    transitionToGroupScreen(message.is_private);
                    if (message.type === 'create_group_success') {
                        alert(`Grupo ${message.group_id} creado exitosamente`);
                    }
                    break;
                case 'create_group_error':
                    alert(`Error al crear el grupo: ${message.message}`);
                    break;
                case 'check_group':
                    if (!message.in_group) {
                        currentGroup = null;
                        localStorage.removeItem('groupId');
                        updateSwipeHint();
                    }
                    break;
                case 'register_success':
                    console.log("Registro exitoso:", message.message);
                    break;
                case 'logout_success':
                    completeLogout();
                    break;
                case 'pong':
                    console.log("Pong recibido");
                    break;
                case 'error':
                    console.error('Error WebSocket:', message.message);
                    alert(`Error: ${message.message}`);
                    break;
                default:
                    console.log('Mensaje desconocido:', message);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos:", event.data);
        }
    };

    ws.onclose = () => {
        console.log("WebSocket cerrado");
        stopPing();
        if (!reconnectInterval) {
            const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 30000);
            reconnectInterval = setTimeout(() => connectWebSocket(sessionToken, retryCount + 1), delay);
        }
    };

    ws.onerror = (error) => {
        console.error("Error en WebSocket:", error);
    };
}

// Ping WebSocket
function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
            console.log("Ping enviado");
        }
    }, PING_INTERVAL);
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// Gestión de audio
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => console.log("Contexto de audio desbloqueado"))
            .catch(err => console.error("Error al desbloquear audio:", err));
    }
}

async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar micrófono:", err);
        alert("No se pudo acceder al micrófono. Habilita los permisos.");
        return null;
    }
}

async function playNextAudio() {
    if (audioQueue.length === 0 || isPlaying) return;
    isPlaying = true;
    const { blob, message } = audioQueue.shift();
    
    try {
        const audio = new Audio(URL.createObjectURL(blob));
        audio.onended = () => {
            isPlaying = false;
            playNextAudio();
        };
        await audio.play();
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaSessionMetadata({
                title: 'Mensaje de voz',
                artist: 'HANDLEPHONE',
                album: 'Comunicación Aeronáutica'
            });
            navigator.mediaSession.setActionHandler('play', () => audio.play());
            navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        }
    } catch (err) {
        console.error("Error reproduciendo audio:", err);
        isPlaying = false;
        playNextAudio();
    }
}

function appendChatMessage(message, audioBlob) {
    const chatListId = message.type === "group_message" ? "group-chat-list" : "chat-list";
    const chatList = document.getElementById(chatListId);
    if (!chatList) return;

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
}

// Grabación de audio
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!talkButton) return;

    if (!isRecording) {
        stream = await requestMicPermission();
        if (!stream) return;

        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        let audioChunks = [];
        let transcript = supportsSpeechRecognition ? "" : "Procesando...";

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = Array.from(event.results)
                    .map(result => result[0].transcript)
                    .join('');
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción";
            };
            recognition.start();
        }

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            if (audioChunks.length === 0) {
                alert("No se grabó audio. Verifica tu micrófono.");
                return;
            }
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                const base64data = reader.result.split(',')[1];
                const message = {
                    type: "audio",
                    data: base64data,
                    text: transcript,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                    sender: localStorage.getItem("userName") || "Anónimo",
                    function: localStorage.getItem("userFunction") || "Desconocida",
                    sessionToken: localStorage.getItem("sessionToken")
                };

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                } else {
                    queueMessageForSync(message);
                }

                appendChatMessage(message, audioBlob);
            };

            stream.getTracks().forEach(track => track.stop());
            stream = null;
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) recognition.stop();
        };

        mediaRecorder.start(100);
        isRecording = true;
        talkButton.classList.add("recording");
    } else {
        mediaRecorder.stop();
        isRecording = false;
        talkButton.classList.remove("recording");
    }
}

async function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) return;

    if (!groupRecording) {
        stream = await requestMicPermission();
        if (!stream) return;

        groupMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        const chunks = [];

        groupMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        groupMediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            if (blob.size === 0) {
                alert("El audio grabado está vacío.");
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const audioData = reader.result.split(',')[1];
                sendGroupMessage(audioData);
            };
            reader.readAsDataURL(blob);
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        };

        groupMediaRecorder.start(100);
        groupRecording = true;
        talkButton.classList.add("recording");
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.classList.remove("recording");
    }
}

function sendGroupMessage(audioData) {
    const message = {
        type: 'group_message',
        data: audioData,
        sender: localStorage.getItem('userName') || "Anónimo",
        function: localStorage.getItem('userFunction') || "Desconocida",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        text: supportsSpeechRecognition ? "Procesando..." : "Procesando...",
        sessionToken: localStorage.getItem("sessionToken"),
        group_id: currentGroup
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        queueMessageForSync(message);
    }
}

// Gestión de vuelos
async function fetchAEPFlights() {
    try {
        const response = await fetch('/api/flights');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        
        flightData = data.flights;
        localStorage.setItem('flightData', JSON.stringify(flightData));
        updateFlightTable(flightData);
    } catch (error) {
        console.error('Error en fetchAEPFlights:', error);
        const cachedFlights = JSON.parse(localStorage.getItem('flightData')) || [];
        if (cachedFlights.length > 0) {
            updateFlightTable(cachedFlights);
        } else {
            document.querySelectorAll('#flights-table tbody').forEach(tbody => {
                tbody.innerHTML = '<tr><td colspan="6">Error al cargar vuelos</td></tr>';
            });
        }
    }
}

function updateFlightTable(flights) {
    document.querySelectorAll('#flights-table tbody').forEach(tbody => {
        tbody.innerHTML = '';
        flights.forEach(flight => {
            const row = document.createElement('tr');
            row.className = getFlightStatusClass(flight.status);
            row.innerHTML = `
                <td>${flight.flight_number || 'N/A'}</td>
                <td>${flight.departure_airport || 'N/A'}</td>
                <td>${flight.departure_time ? new Date(flight.departure_time).toLocaleString('es-AR') : 'N/A'}</td>
                <td>${flight.arrival_airport || 'N/A'}</td>
                <td>${flight.arrival_time ? new Date(flight.arrival_time).toLocaleString('es-AR') : 'N/A'}</td>
                <td>${flight.status || 'Desconocido'}</td>
            `;
            tbody.appendChild(row);
        });
    });
}

function getFlightStatusClass(status) {
    if (!status) return '';
    const statusLower = status.toLowerCase();
    const statusMap = {
        'aterrizando': 'flight-aterrizando',
        'landing': 'flight-aterrizando',
        'en vuelo': 'flight-en-vuelo',
        'en route': 'flight-en-vuelo',
        'despegando': 'flight-despegando',
        'taking off': 'flight-despegando',
        'en tierra': 'flight-en-tierra',
        'on ground': 'flight-en-tierra',
        'salida': 'flight-salida',
        'departed': 'flight-salida'
    };
    return statusMap[statusLower] || '';
}

function startFlightUpdates() {
    stopFlightUpdates();
    flightInterval = setInterval(fetchAEPFlights, FLIGHT_UPDATE_INTERVAL);
    console.log('Actualizaciones de vuelos iniciadas');
}

function stopFlightUpdates() {
    if (flightInterval) {
        clearInterval(flightInterval);
        flightInterval = null;
        console.log('Actualizaciones de vuelos detenidas');
    }
}

// Mapa y radar
function initMap() {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado");
        alert("Error al cargar el mapa.");
        return;
    }

    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`, {
            maxZoom: 18,
            tileSize: 512,
            zoomOffset: -1,
            attribution: '© Mapbox © OpenStreetMap'
        }).addTo(map);
        console.log("Mapa inicializado");
        map.invalidateSize();
    } catch (error) {
        console.error("Error al inicializar Leaflet:", error);
        alert("Error al cargar el mapa.");
    }
}

function updateOpenSkyData(flightsData) {
    if (!map) return;

    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    Object.values(flightPaths).forEach(path => map.removeLayer(path));
    flightPaths = {};

    const planeIcon = L.icon({
        iconUrl: '/templates/airplane.png',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });

    flightsData.forEach(flight => {
        if (flight.lat && flight.lon) {
            const marker = L.Marker.movingMarker(
                [[flight.lat, flight.lon], [flight.lat, flight.lon]],
                [10000],
                { icon: planeIcon, rotationAngle: flight.heading || 0 }
            ).addTo(map);
            marker.flight = flight.flight;
            marker.registration = flight.registration;
            marker.bindPopup(
                `Vuelo: ${flight.flight}<br>` +
                `Destino: ${flight.destination || 'N/A'}<br>` +
                `Estado: ${flight.status || 'Desconocido'}<br>` +
                `Altitud: ${flight.alt_geom ? Math.round(flight.alt_geom) : 'N/A'} ft<br>` +
                `Velocidad: ${flight.gs ? Math.round(flight.gs) : 'N/A'} kts`
            );
            markers.push(marker);
            flightPaths[flight.flight] = L.polyline([[flight.lat, flight.lon]], { color: 'blue' }).addTo(map);
        }
    });

    const airportIcon = L.icon({
        iconUrl: '/templates/airport.png',
        iconSize: [30, 30],
    });
    const aeroparqueMarker = L.marker([-34.5597, -58.4116], { icon: airportIcon })
        .addTo(map)
        .bindPopup("Aeroparque")
        .openPopup();
    markers.push(aeroparqueMarker);
}

function filterFlights() {
    const searchTerm = document.getElementById("search-bar")?.value.toUpperCase().trim() || '';
    markers.forEach(marker => {
        const flight = marker.flight || "";
        const registration = marker.registration || "";
        const matches = registration.toUpperCase().includes(searchTerm) ||
                       flight.toUpperCase().includes(searchTerm) ||
                       searchTerm === "";
        if (matches && !map.hasLayer(marker)) {
            marker.addTo(map);
        } else if (!matches && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    });
    if (map) map.invalidateSize();
}

// Modal de detalles de vuelos
function openFlightDetailsModal() {
    const modal = document.getElementById('flight-details-modal');
    const modalTableBody = document.getElementById('modal-flight-table')?.querySelector('tbody');
    const mainTableBody = document.querySelector('#flights-table tbody');

    if (!modal || !modalTableBody || !mainTableBody) {
        console.error('Elementos del modal no encontrados');
        return;
    }

    modalTableBody.innerHTML = mainTableBody.innerHTML || '<tr><td colspan="6">No hay datos</td></tr>';
    modal.style.display = 'block';

    modalTableBody.querySelectorAll('tr').forEach(row => {
        row.addEventListener('click', async () => {
            const flightNumber = row.cells[0].textContent;
            try {
                const response = await fetch(`/api/flight_details/${flightNumber}`);
                if (!response.ok) throw new Error('Error al obtener detalles');
                const details = await response.json();
                displayFlightDetails(details);
            } catch (error) {
                console.error('Error al obtener detalles:', error);
                alert('Error al cargar detalles del vuelo');
            }
        });
    });
}

function displayFlightDetails(details) {
    alert(`Detalles del vuelo ${details.flight_number}:
- Origen: ${details.departure_airport}
- Destino: ${details.arrival_airport}
- Salida: ${details.departure_time ? new Date(details.departure_time).toLocaleString('es-AR') : 'N/A'}
- Llegada: ${details.arrival_time ? new Date(details.arrival_time).toLocaleString('es-AR') : 'N/A'}
- Estado: ${details.status}`);
}

function closeFlightDetailsModal() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) modal.style.display = 'none';
}

// Búsqueda de vuelos
function sendSearchQuery() {
    const query = document.getElementById('search-input')?.value.trim();
    if (!query) {
        alert('Ingresa una consulta');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'search_query', query }));
        localStorage.setItem('lastSearchQuery', query);
        document.getElementById('search-input').value = '';
    } else {
        alert('No conectado al servidor');
        localStorage.removeItem('lastSearchQuery');
    }
}

function displaySearchResponse(message) {
    const flightDetails = document.getElementById('flight-details');
    const groupFlightDetails = document.getElementById('group-flight-details');
    if (!flightDetails || !groupFlightDetails) return;

    flightDetails.innerHTML = '';
    groupFlightDetails.innerHTML = '';

    let flights = Array.isArray(message) ? message : parseFlightMessage(message);
    const searchQuery = localStorage.getItem('lastSearchQuery')?.toLowerCase() || '';
    const filteredFlights = flights.filter(flight =>
        flight.flightNumber.toLowerCase().includes(searchQuery) ||
        flight.destination.toLowerCase().includes(searchQuery)
    );

    if (filteredFlights.length === 0) {
        flightDetails.innerHTML = '<div class="flight no-results">No se encontraron vuelos.</div>';
        groupFlightDetails.innerHTML = '<div class="flight no-results">No se encontraron vuelos.</div>';
    } else {
        filteredFlights.forEach(flight => {
            const div = document.createElement('div');
            div.className = `flight ${getFlightStatusClass(flight.status)}`;
            div.innerHTML = `
                <strong>Vuelo:</strong> ${flight.flightNumber} |
                <strong>Destino:</strong> ${flight.destination} |
                <strong>Estado:</strong> ${flight.status}
            `;
            flightDetails.appendChild(div);
            groupFlightDetails.appendChild(div.cloneNode(true));
        });
    }

    flightDetails.scrollTop = flightDetails.scrollHeight;
    groupFlightDetails.scrollTop = groupFlightDetails.scrollHeight;
}

function parseFlightMessage(message) {
    const flights = [];
    if (typeof message === 'string') {
        const entries = message.split(", ");
        for (let i = 0; i < entries.length; i += 3) {
            if (entries[i].startsWith("AR")) {
                flights.push({
                    flightNumber: entries[i],
                    destination: entries[i + 1]?.split(" ")[2] || 'N/A',
                    status: entries[i + 2] || 'Desconocido'
                });
            }
        }
    }
    return flights;
}

// Gestión de usuarios
function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) return;

    usersDiv.innerHTML = `Usuarios conectados: ${count}<br>`;
    groupUsersDiv.innerHTML = `Usuarios conectados: ${list.filter(user => user.group_id === currentGroup).length}<br>`;

    const userList = document.createElement("div");
    userList.className = "user-list";
    const groupUserList = document.createElement("div");
    groupUserList.className = "user-list";

    list.forEach(user => {
        const userDiv = createUserItem(user);
        userList.appendChild(userDiv);

        if (user.group_id === currentGroup) {
            groupUserList.appendChild(createUserItem(user));
        }
    });

    usersDiv.appendChild(userList);
    groupUsersDiv.appendChild(groupUserList);
}

function createUserItem(user) {
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

    const userText = document.createElement("span");
    let displayText = user.display || user.user_id;
    if (displayText === user.user_id) {
        const [, name, userFunction] = user.user_id.split('_');
        displayText = `${name} (${userFunction})`;
    }
    userText.textContent = displayText;

    userDiv.appendChild(muteButton);
    userDiv.appendChild(userText);
    return userDiv;
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
    } else {
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
    }
}

// Muteo
function toggleMute() {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    const isMuted = muteButton.classList.contains("active");

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuted ? "unmute_all" : "mute_all" }));
    }

    muteButton.classList.toggle("active");
    if (groupMuteButton) groupMuteButton.classList.toggle("active");
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById("group-mute");
    const muteButton = document.getElementById("mute");
    const isMuted = groupMuteButton.classList.contains("active");

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuted ? "unmute_all" : "mute_all" }));
    }

    groupMuteButton.classList.toggle("active");
    if (muteButton) muteButton.classList.toggle("active");
}

function updateMuteButton(isMuted) {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (isMuted) {
        muteButton.classList.add("active");
        if (groupMuteButton) groupMuteButton.classList.add("active");
    } else {
        muteButton.classList.remove("active");
        if (groupMuteButton) groupMuteButton.classList.remove("active");
    }
}

function toggleMuteNonGroup() {
    const button = document.getElementById("mute-non-group");
    const isMuting = !button.classList.contains("muted");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuting ? "mute_non_group" : "unmute_non_group", group_id: currentGroup }));
    }
}

function updateMuteNonGroupButton(isMuted) {
    const button = document.getElementById("mute-non-group");
    if (isMuted) {
        button.classList.add("muted");
        button.innerHTML = '<img src="/templates/mute.png" alt="Desmutear" style="width: 24px; height: 24px;">';
    } else {
        button.classList.remove("muted");
        button.innerHTML = '<img src="/templates/mute.png" alt="Silenciar" style="width: 24px; height: 24px;">';
    }
}

// Grupos
function createGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor.');
    }
}

function joinGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor.');
    }
}

function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        localStorage.removeItem('groupId');
        transitionToMainScreen();
    }
}

function transitionToGroupScreen(isPrivate) {
    document.getElementById('main').classList.add('slide-left');
    setTimeout(() => {
        document.getElementById('main').style.display = 'none';
        document.getElementById('group-screen').style.display = 'block';
        document.getElementById('main').classList.remove('slide-left');
        if (isPrivate) {
            const logoutButton = document.getElementById('logout-button');
            if (logoutButton) logoutButton.style.display = 'none';
        }
        updateSwipeHint();
    }, 300);
}

function transitionToMainScreen() {
    document.getElementById('group-screen').classList.add('slide-right');
    setTimeout(() => {
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('group-screen').classList.remove('slide-right');
        document.getElementById('group-chat-list').innerHTML = '';
        document.getElementById('group-flight-details').innerHTML = '';
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) logoutButton.style.display = 'block';
        updateSwipeHint();
    }, 300);
}

function returnToGroup() {
    if (currentGroup) {
        transitionToGroupScreen();
    }
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (!swipeHint || !returnToGroupBtn) return;

    if (currentGroup) {
        if (document.getElementById('main').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Desliza hacia la derecha para ir al grupo';
            returnToGroupBtn.style.display = 'block';
        } else if (document.getElementById('group-screen').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Desliza hacia la izquierda para volver';
            returnToGroupBtn.style.display = 'none';
        }
    } else {
        swipeHint.style.display = 'none';
        returnToGroupBtn.style.display = 'none';
    }
}

// Navegación
function showRadar() {
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function showGroupRadar() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function backToMainFromRadar() {
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    document.getElementById("search-bar").value = "";
    filterFlights();
    updateSwipeHint();
}

function showHistory() {
    document.getElementById("main").style.display = "none";
    document.getElementById("history-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    loadHistory();
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    loadHistory();
}

function backToMain() {
    document.getElementById("history-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    updateSwipeHint();
}

// Historial
async function loadHistory() {
    const historyList = document.getElementById("history-list");
    if (!historyList) return;

    try {
        const response = await fetch('/api/history');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        historyList.innerHTML = "";
        data.forEach(msg => {
            const msgDiv = document.createElement("div");
            msgDiv.className = "chat-message";
            const utcTime = msg.timestamp.split(":");
            const utcDate = new Date();
            utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
            const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            const text = msg.text || "Sin transcripción";
            msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${text}`;
            const audioBlob = base64ToBlob(msg.audio, 'audio/webm');
            if (audioBlob) {
                msgDiv.onclick = () => playAudio(audioBlob);
            }
            historyList.appendChild(msgDiv);
        });
    } catch (err) {
        console.error("Error al cargar historial:", err);
        historyList.innerHTML = "<div>Error al cargar el historial</div>";
    }
}

// Service Worker y notificaciones
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/templates/sw.js')
            .then(() => console.log('Service Worker registrado'))
            .catch(err => console.error('Error al registrar Service Worker:', err));
    }
}

function checkNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                console.log('Permiso de notificación concedido');
                subscribeToPush();
            }
        });
    }
}

function subscribeToPush() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            }).then(subscription => {
                fetch('/subscribe', {
                    method: 'POST',
                    body: JSON.stringify(subscription),
                    headers: { 'Content-Type': 'application/json' }
                });
            });
        });
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function queueMessageForSync(message) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'QUEUE_MESSAGE',
            message: message
        });
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register(SYNC_TAG).catch(err => {
                console.error('Error al registrar sync:', err);
            });
        });
    } else {
        alert('No se pudo guardar el mensaje. Verifica la conexión.');
    }
}

// Auxiliares
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

function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    if (mediaRecorder) {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
    if (groupMediaRecorder) {
        groupMediaRecorder.stop();
        groupMediaRecorder = null;
    }
    localStorage.clear();
    currentGroup = null;
    mutedUsers.clear();
    clearInterval(reconnectInterval);
    stopPing();
    stopFlightUpdates();
    showScreen('login-form');
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    const MAPBOX_TOKEN = 'TU_TOKEN_DE_MAPBOX'; // Reemplaza con tu token de Mapbox
    initSpeechRecognition();
    registerServiceWorker();
    checkNotificationPermission();

    // Verificar sesión
    const sessionToken = localStorage.getItem('token');
    const userName = localStorage.getItem('userName');
    const userFunction = localStorage.getItem('userFunction');
    const userLegajo = localStorage.getItem('userLegajo');

    if (sessionToken && userName && userFunction && userLegajo) {
        userId = `${userLegajo}_${userName}_${userFunction}`;
        token = sessionToken;
        connectWebSocket(sessionToken);
        showScreen('main');
        checkGroupStatus();
        fetchAEPFlights();
        startFlightUpdates();
    } else {
        showScreen('login-form');
    }

    // Event listeners
// Formulario de registro
    const registerForm = document.getElementById('register-form');
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
    const loginForm = document.getElementById('login-form');
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
                    token = data.token;
                    const [legajo, name, sector] = atob(token).split('_');
                    userId = `${legajo}_${name}_${sector}`;
                    localStorage.setItem('token', token);
                    localStorage.setItem('userName', name);
                    localStorage.setItem('userFunction', sector);
                    localStorage.setItem('userLegajo', legajo);
                    connectWebSocket(token);
                    showScreen('main');
                    checkGroupStatus();
                    fetchAEPFlights();
                    startFlightUpdates();
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

    document.getElementById('search-button')?.addEventListener('click', sendSearchQuery);
    document.querySelectorAll('#flight-details-button').forEach(button => {
        button.addEventListener('click', openFlightDetailsModal);
    });
    document.getElementById('close-modal')?.addEventListener('click', closeFlightDetailsModal);
    document.getElementById('flight-details-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeFlightDetailsModal();
    });
    // Event listeners para botones
    document.getElementById('logout-button')?.addEventListener('click', logout);
    document.getElementById('join-group-btn')?.addEventListener('click', joinGroup);
    document.getElementById('create-group-btn')?.addEventListener('click', createGroup);
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
    document.getElementById('mute-non-group')?.addEventListener('click', toggleMuteNonGroup);
    document.getElementById('search-bar')?.addEventListener('input', filterFlights);
    document.querySelector('.close-btn')?.addEventListener('click', backToMainFromRadar);
    document.querySelectorAll('#main-flight-details-button, #group-flight-details-button').forEach(button => {
        button.addEventListener('click', openFlightDetailsModal);
    });
    document.getElementById('close-modal')?.addEventListener('click', () => {
        document.getElementById('flight-details-modal').style.display = 'none';
    });
    
    // Gestos táctiles
    document.addEventListener('touchstart', e => {
        if (!isSwiping) startX = e.touches[0].clientX;
    });

    document.addEventListener('touchmove', e => {
        if (!isSwiping) currentX = e.touches[0].clientX;
    });

    document.addEventListener('touchend', () => {
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

    // Tecla VolumeUp
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

    // Desbloquear audio
    document.addEventListener('click', unlockAudio, { once: true });

    // Manejo de visibilidad
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log('App en segundo plano');
        } else {
            console.log('App en primer plano');
            if (ws && ws.readyState !== WebSocket.OPEN) {
                const sessionToken = localStorage.getItem('token');
                if (sessionToken) connectWebSocket(sessionToken);
            }
        }
    });

    // Mensajes del Service Worker
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'SEND_MESSAGE' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event.data.message));
            console.log('Mensaje sincronizado enviado:', event.data.message);
        } else if (event.data?.type === 'SYNC_COMPLETE') {
            console.log('Sincronización completada');
        }
    });
});
