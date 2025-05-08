// -------------------- SECCIÓN: Variables globales --------------------
let ws = null;
let pingInterval = null;
let userId = null;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder = null;
let stream = null;
let map = null;
let audioQueue = [];
let isPlaying = false;
let markers = [];
let recognition = null;
let supportsSpeechRecognition = false;
let mutedUsers = new Set();
let currentGroup = null;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let flightData = [];
let reconnectInterval = null;
let groupMediaRecorder = null;
const PING_INTERVAL = 30000; // Ping cada 30 segundos
const RECONNECT_BASE_DELAY = 5000; // Reintento base cada 5 segundos
const SYNC_TAG = 'sync-messages'; // Tag para sincronización

// Mapeo de aerolíneas
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// -------------------- SECCIÓN: Inicializar SpeechRecognition --------------------
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    supportsSpeechRecognition = true;
    console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
} else {
    console.warn("SpeechRecognition no soportado. Navegador:", navigator.userAgent);
    alert("Tu navegador no soporta speech-to-text en el cliente. El servidor transcribirá el audio.");
}

// -------------------- SECCIÓN: Restaurar sesión y eventos DOM --------------------
document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();

    const sessionToken = localStorage.getItem('sessionToken');
    const userName = localStorage.getItem('userName');
    const userFunction = localStorage.getItem('userFunction');
    const userLegajo = localStorage.getItem('userLegajo');

    if (window.location.pathname === '/register-form') {
        document.getElementById('register').style.display = 'block';
        document.getElementById('main').style.display = 'none';
    } else if (sessionToken && userName && userFunction && userLegajo) {
        userId = `${userLegajo}_${userName}_${userFunction}`;
        connectWebSocket(sessionToken);
        document.getElementById('register').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        checkGroupStatus();
        fetchAA2000Flights();
        setInterval(fetchAA2000Flights, 300000);
        updateOpenSkyData();
    } else {
        window.location.href = '/register-form';
    }

    document.getElementById('register-button')?.addEventListener('click', register);
    document.getElementById('search-button')?.addEventListener('click', sendSearchQuery);
    document.getElementById('logout-button')?.addEventListener('click', logout);
    document.getElementById('talk')?.addEventListener('click', toggleTalk);
    document.getElementById('group-talk')?.addEventListener('click', toggleGroupTalk);
    document.getElementById('mute')?.addEventListener('click', toggleMute);
    document.getElementById('create-group-button')?.addEventListener('click', createGroup);
    document.getElementById('join-group-button')?.addEventListener('click', joinGroup);
    document.getElementById('leave-group-button')?.addEventListener('click', leaveGroup);
    document.getElementById('show-radar-button')?.addEventListener('click', showRadar);
    document.getElementById('back-to-main-radar-button')?.addEventListener('click', backToMainFromRadar);
    document.getElementById('show-history-button')?.addEventListener('click', showHistory);
    document.getElementById('back-to-main-history-button')?.addEventListener('click', backToMain);
    document.getElementById('return-to-group-btn')?.addEventListener('click', returnToGroup);

    checkNotificationPermission();

    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'SEND_MESSAGE' && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event.data.message));
            console.log('Mensaje sincronizado enviado:', event.data.message);
        } else if (event.data?.type === 'SYNC_COMPLETE') {
            console.log('Sincronización completada');
        }
    });

    // Añadir campo para especificar el año de FlightRadar24
    const fr24YearInput = document.getElementById('fr24-year-input');
    if (fr24YearInput) {
        fr24YearInput.addEventListener('change', () => {
            const year = fr24YearInput.value;
            if (year && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'fr24_year_query', year }));
                console.log(`Solicitando datos de FlightRadar24 para el año: ${year}`);
            }
        });
    }
});

// -------------------- SECCIÓN: Manejar visibilidad de pestaña --------------------
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ws?.readyState !== WebSocket.OPEN) {
        const sessionToken = localStorage.getItem('sessionToken');
        if (sessionToken) connectWebSocket(sessionToken);
    }
});

// -------------------- SECCIÓN: Service Worker y notificaciones --------------------
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
            .catch(err => console.warn('No se pudo verificar sw.js:', err));
    }
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
        console.error('Service Worker no disponible');
        alert('No se pudo guardar el mensaje.');
    }
}

function checkNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') console.log('Permiso de notificaciones concedido');
        });
    }
}

// -------------------- SECCIÓN: Audio --------------------
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => console.log("Contexto de audio desbloqueado"));
    }
}

async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar permiso de micrófono:", err);
        alert("No se pudo acceder al micrófono.");
        return null;
    }
}

function playAudio(blob) {
    if (!blob || blob.size === 0) {
        console.error("Blob de audio inválido o vacío");
        return;
    }
    const audio = new Audio(URL.createObjectURL(blob));
    audioQueue.push(audio);
    playNextAudio();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaSessionMetadata({
            title: 'Mensaje de voz',
            artist: 'HandyHandle',
            album: 'Comunicación Aeronáutica'
        });
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    }
}

function playNextAudio() {
    if (audioQueue.length === 0 || isPlaying) return;
    isPlaying = true;
    const audio = audioQueue.shift();
    audio.play().then(() => {
        console.log("Audio reproducido");
        isPlaying = false;
        playNextAudio();
    }).catch(err => {
        console.error("Error reproduciendo audio:", err);
        isPlaying = false;
        playNextAudio();
    });
}

// -------------------- SECCIÓN: WebSocket --------------------
async function connectWebSocket(sessionToken, retryCount = 0) {
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket conectado');
        clearInterval(reconnectInterval);
        ws.send(JSON.stringify({
            type: 'register',
            legajo: localStorage.getItem('userLegajo'),
            name: localStorage.getItem('userName'),
            function: localStorage.getItem('userFunction')
        }));
        startPing();
        fetchAA2000Flights();
        updateOpenSkyData();
        checkGroupStatus();
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register(SYNC_TAG).catch(err => console.error('Error al registrar sync:', err));
        });
    };

    ws.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'connection_success':
                case 'register_success':
                    console.log(`${message.type}: ${message.message}`);
                    document.getElementById('register').style.display = 'none';
                    document.getElementById('main').style.display = 'block';
                    break;
                case 'audio':
                    if (!mutedUsers.has(`${message.sender}_${message.function}`)) {
                        const audioBlob = base64ToBlob(message.data, 'audio/webm');
                        if (audioBlob) {
                            playAudio(audioBlob);
                            addChatMessage(message, 'chat-list');
                        }
                    }
                    break;
                case 'group_message':
                    if (currentGroup === message.group_id && !mutedUsers.has(`${message.sender}_${message.function}`)) {
                        const audioBlob = base64ToBlob(message.data, 'audio/webm');
                        if (audioBlob) {
                            playAudio(audioBlob);
                            addChatMessage(message, 'group-chat-list');
                        }
                    }
                    break;
                case 'users':
                    updateUsers(message.count, message.list);
                    break;
                case 'flight_update':
                    updateFlightDetails(message.flights, '#flight-details');
                    updateFlightDetails(message.flights, '#group-flight-details');
                    break;
                case 'fr24_update':
                    updateFlightRadar24Markers(message.flights);
                    break;
                case 'aa2000_flight_update':
                    updateFlightDetailsAA2000(message.flights, '#flight-details');
                    updateFlightDetailsAA2000(message.flights, '#group-flight-details');
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
                    document.getElementById('mute-non-group')?.classList.add('muted').textContent = 'Desmutear no grupo';
                    break;
                case 'unmute_non_group_success':
                    message.user_ids.forEach(id => mutedUsers.delete(id));
                    updateUsers(message.count, message.list);
                    document.getElementById('mute-non-group')?.classList.remove('muted').textContent = 'Mutear no grupo';
                    break;
                case 'group_joined':
                case 'create_group_success':
                    currentGroup = message.group_id;
                    localStorage.setItem('groupId', currentGroup);
                    document.getElementById('main').style.display = 'none';
                    document.getElementById('group-screen').style.display = 'block';
                    if (message.is_private) document.getElementById('logout-button').style.display = 'none';
                    updateSwipeHint();
                    break;
                case 'create_group_error':
                    alert(`Error al crear grupo: ${message.message}`);
                    break;
                case 'check_group':
                    if (!message.in_group) {
                        currentGroup = null;
                        localStorage.removeItem('groupId');
                        updateSwipeHint();
                    }
                    break;
                case 'pong':
                    console.log('Pong recibido');
                    break;
                case 'logout_success':
                    logout();
                    break;
                case 'register_error':
                    alert(`Error al registrar: ${message.message}`);
                    localStorage.clear();
                    window.location.href = '/register-form';
                    break;
            }
        } catch (err) {
            console.error('Error procesando mensaje:', err);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket cerrado');
        stopPing();
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 30000);
        reconnectInterval = setTimeout(() => connectWebSocket(sessionToken, retryCount + 1), delay);
    };

    ws.onerror = (error) => {
        console.error('Error WebSocket:', error);
        ws.close();
    };
}

function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, PING_INTERVAL);
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// -------------------- SECCIÓN: Registro --------------------
async function register() {
    const legajo = document.getElementById('userLegajo')?.value;
    const name = document.getElementById('userName')?.value;
    const userFunction = document.getElementById('userFunction')?.value;

    if (!legajo || !name || !userFunction) {
        alert('Completa todos los campos.');
        return;
    }
    if (!/^\d{5}$/.test(legajo)) {
        alert('El legajo debe tener 5 números.');
        return;
    }

    // Verificar si el usuario ya está registrado
    try {
        const response = await fetch('/check_user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ legajo, name, function: userFunction })
        });
        const result = await response.json();
        if (result.exists) {
            alert('Usuario ya registrado. Inicia sesión o usa otro legajo.');
            return;
        }
    } catch (err) {
        console.error('Error al verificar usuario:', err);
        alert('Error al verificar registro. Intenta de nuevo.');
        return;
    }

    const sessionToken = btoa(`${legajo}_${name}_${userFunction}`);
    localStorage.setItem('sessionToken', sessionToken);
    localStorage.setItem('userName', name);
    localStorage.setItem('userFunction', userFunction);
    localStorage.setItem('userLegajo', legajo);
    userId = `${legajo}_${name}_${userFunction}`;

    connectWebSocket(sessionToken);
}

// -------------------- SECCIÓN: Búsqueda --------------------
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
    }
}

function displaySearchResponse(message) {
    const flightDetails = document.getElementById('flight-details');
    const groupFlightDetails = document.getElementById('group-flight-details');
    if (!flightDetails || !groupFlightDetails) return;

    flightDetails.innerHTML = '';
    groupFlightDetails.innerHTML = '';

    let flights = Array.isArray(message) ? message : parseFlightMessage(message);
    const searchQuery = localStorage.getItem('lastSearchQuery') || '';
    const filteredFlights = flights.filter(flight =>
        flight.flightNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flight.destination.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (filteredFlights.length === 0) {
        const div = document.createElement('div');
        div.className = 'flight no-results';
        div.textContent = 'No se encontraron vuelos.';
        flightDetails.appendChild(div);
        groupFlightDetails.appendChild(div.cloneNode(true));
    } else {
        filteredFlights.forEach(flight => {
            const div = document.createElement('div');
            div.className = `flight flight-${flight.status.toLowerCase().replace(' ', '-')}`;
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
        const flightEntries = message.split(', ');
        for (let i = 0; i < flightEntries.length; i += 3) {
            if (flightEntries[i].startsWith('AR')) {
                flights.push({
                    flightNumber: flightEntries[i],
                    destination: flightEntries[i + 1]?.split(' ')[2] || 'N/A',
                    status: flightEntries[i + 2] || 'Desconocido'
                });
            }
        }
    }
    return flights;
}

// -------------------- SECCIÓN: Vuelos --------------------
async function fetchAA2000Flights() {
    try {
        const response = await fetch('/aa2000_flights');
        const data = await response.json();
        updateFlightDetailsAA2000(data.flights, '#flight-details');
        updateFlightDetailsAA2000(data.flights, '#group-flight-details');
    } catch (err) {
        console.error('Error al obtener vuelos de AA2000:', err);
    }
}

function updateFlightDetails(flights, containerId) {
    const container = document.querySelector(containerId);
    if (!container) return;
    container.innerHTML = '';
    flights.forEach(flight => {
        if (flight.Vuelo.startsWith('AR')) {
            const div = document.createElement('div');
            div.className = `flight flight-${flight.Estado.toLowerCase().replace(' ', '-')}`;
            div.innerHTML = `
                <strong>Vuelo:</strong> ${flight.Vuelo} |
                <strong>STD:</strong> ${flight.STD} |
                <strong>Destino:</strong> ${flight.Destino} |
                <strong>Posición:</strong> ${flight.Posicion} |
                <strong>Matrícula:</strong> ${flight.Matricula} |
                <strong>Estado:</strong> ${flight.Estado}
            `;
            container.appendChild(div);
        }
    });
    container.scrollTop = container.scrollHeight;
}

function updateFlightDetailsAA2000(flights, containerId) {
    const container = document.querySelector(containerId);
    if (!container) return;
    container.innerHTML = '';
    flights.forEach(flight => {
        const div = document.createElement('div');
        div.className = `flight flight-${flight.status.toLowerCase().replace(' ', '-')}`;
        div.innerHTML = `
            <strong>Vuelo:</strong> AR${flight.flight_number} |
            <strong>Origen:</strong> ${flight.origin} |
            <strong>Destino:</strong> ${flight.destination} |
            <strong>Estado:</strong> ${flight.status} |
            <strong>Aeronave:</strong> ${flight.aircraft} |
            <strong>Matrícula:</strong> ${flight.registration}
        `;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

async function updateOpenSkyData() {
    try {
        const [openskyResponse, aa2000Response] = await Promise.all([
            fetch('/opensky'),
            fetch('/aa2000_flights')
        ]);
        const openskyData = openskyResponse.ok ? await openskyResponse.json() : [];
        const aa2000Data = aa2000Response.ok ? await aa2000Response.json() : { flights: [] };

        const flightDetails = document.getElementById('flight-details');
        const groupFlightDetails = document.getElementById('group-flight-details');
        if (!flightDetails || !groupFlightDetails) return;

        flightDetails.innerHTML = '';
        groupFlightDetails.innerHTML = '';

        if (map) {
            markers = markers.filter(marker => marker.isFlightRadar24 || marker.getPopup().getContent() === 'Aeroparque');
        }

        openskyData.forEach(state => {
            if (state.flight.startsWith('AR') || state.flight.startsWith('ARG')) {
                const flightNumber = state.flight.replace('ARG', '').replace('AR', '');
                const displayFlight = `AEP${flightNumber}`;
                const div = document.createElement('div');
                div.className = `flight flight-${state.status.toLowerCase().replace(' ', '-')}`;
                div.innerHTML = `
                    <strong>Vuelo:</strong> ${displayFlight} |
                    <strong>STD:</strong> ${state.scheduled} |
                    <strong>Posición:</strong> ${state.position} |
                    <strong>Destino:</strong> ${state.destination} |
                    <strong>Matrícula:</strong> ${state.registration} |
                    <strong>Estado:</strong> ${state.status}
                `;
                flightDetails.appendChild(div);
                groupFlightDetails.appendChild(div.cloneNode(true));

                if (state.lat && state.lon && map) {
                    const marker = L.marker([state.lat, state.lon], {
                        icon: L.icon({
                            iconUrl: '/templates/aero.png',
                            iconSize: [30, 30]
                        })
                    }).addTo(map)
                      .bindPopup(`Vuelo: ${displayFlight} / ${state.registration}<br>Ruta: ${state.origin_dest}<br>Estado: ${state.status}`);
                    marker.flight = state.flight;
                    marker.registration = state.registration;
                    markers.push(marker);
                }
            }
        });

        updateFlightDetailsAA2000(aa2000Data.flights, '#flight-details');
        updateFlightDetailsAA2000(aa2000Data.flights, '#group-flight-details');
    } catch (err) {
        console.error('Error al cargar datos de vuelos:', err);
    }
    setTimeout(updateOpenSkyData, 15000);
}

function updateFlightRadar24Markers(flights) {
    if (map) {
        markers = markers.filter(marker => !marker.isFlightRadar24);
        flights.forEach(flight => {
            if (flight.latitude && flight.longitude) {
                const marker = L.marker([flight.latitude, flight.longitude], {
                    icon: L.icon({
                        iconUrl: '/templates/aero.png',
                        iconSize: [30, 30]
                    })
                }).addTo(map)
                  .bindPopup(`Vuelo: ${flight.flight}<br>Origen: ${flight.origin}<br>Destino: ${flight.destination}<br>Estado: ${flight.status}<br>Año: ${flight.year || 'Actual'}`);
                marker.flight = flight.flight;
                marker.isFlightRadar24 = true;
                markers.push(marker);
            }
        });
        console.log("Marcadores FlightRadar24 actualizados:", flights.length);
    }
}

// -------------------- SECCIÓN: Mapa --------------------
function initMap() {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;
    map = L.map('map').setView([-34.5597, -58.4116], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);
    L.marker([-34.5597, -58.4116], {
        icon: L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30]
        })
    }).addTo(map).bindPopup('Aeroparque').openPopup();
    map.invalidateSize();
}

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

function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "En zona";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

// -------------------- SECCIÓN: Grabación --------------------
async function toggleTalk() {
    const talkButton = document.getElementById('talk');
    if (!talkButton) return;

    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        stream = await requestMicPermission();
        if (!stream) return;

        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        let transcript = supportsSpeechRecognition ? '' : 'Procesando...';

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = event => {
                transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            };
            recognition.onerror = event => {
                transcript = 'Error en transcripción: ' + event.error;
            };
            recognition.start();
        }

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            if (audioBlob.size === 0) {
                alert('El audio grabado está vacío.');
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                const base64data = reader.result.split(',')[1];
                const message = {
                    type: 'audio',
                    data: base64data,
                    text: transcript,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                    sender: localStorage.getItem('userName') || 'Anónimo',
                    function: localStorage.getItem('userFunction') || 'Desconocida',
                    sessionToken: localStorage.getItem('sessionToken')
                };

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                } else {
                    queueMessageForSync(message);
                }

                addChatMessage(message, 'chat-list');
                audioChunks = [];
                stream.getTracks().forEach(track => track.stop());
                stream = null;
                if (supportsSpeechRecognition && recognition) recognition.stop();
            };
            mediaRecorder = null;
        };

        mediaRecorder.start(100);
        talkButton.classList.add('recording');
    } else if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        talkButton.classList.remove('recording');
    }
}

async function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) return;

    if (!groupMediaRecorder) {
        stream = await requestMicPermission();
        if (!stream) return;

        groupMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        const chunks = [];

        groupMediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        groupMediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            if (blob.size === 0) return;
            const reader = new FileReader();
            reader.onload = () => {
                const audioData = reader.result.split(',')[1];
                const message = {
                    type: 'group_message',
                    data: audioData,
                    sender: localStorage.getItem('userName') || 'Anónimo',
                    function: localStorage.getItem('userFunction') || 'Desconocida',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
                    text: supportsSpeechRecognition ? 'Procesando...' : 'Procesando...',
                    group_id: currentGroup,
                    sessionToken: localStorage.getItem('sessionToken')
                };

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                } else {
                    queueMessageForSync(message);
                }

                stream.getTracks().forEach(track => track.stop());
                stream = null;
            };
            reader.readAsDataURL(blob);
            groupMediaRecorder = null;
        };

        groupMediaRecorder.start(100);
        talkButton.classList.add('recording');
    } else {
        groupMediaRecorder.stop();
        talkButton.classList.remove('recording');
    }
}

function addChatMessage(message, chatListId) {
    const chatList = document.getElementById(chatListId);
    if (!chatList) return;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message';
    const timestamp = message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const sender = message.sender || 'Anónimo';
    const userFunction = message.function || 'Desconocida';
    const text = message.text || 'Sin transcripción';
    msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${text}`;
    const audioBlob = base64ToBlob(message.data, 'audio/webm');
    if (audioBlob) msgDiv.onclick = () => playAudio(audioBlob);
    chatList.appendChild(msgDiv);
    chatList.scrollTop = chatList.scrollHeight;
}

// -------------------- SECCIÓN: Muteo --------------------
function toggleMute() {
    const muteButton = document.getElementById('mute');
    if (muteButton.classList.contains('unmuted')) {
        ws.send(JSON.stringify({ type: 'mute_all' }));
        muteButton.classList.remove('unmuted').add('muted');
    } else {
        ws.send(JSON.stringify({ type: 'unmute_all' }));
        muteButton.classList.remove('muted').add('unmuted');
    }
}

function updateMuteButton(isMuted) {
    const muteButton = document.getElementById('mute');
    const groupMuteButton = document.getElementById('group-mute');
    if (isMuted) {
        muteButton.classList.remove('unmuted').add('muted');
        if (groupMuteButton) groupMuteButton.classList.remove('unmuted').add('muted');
    } else {
        muteButton.classList.remove('muted').add('unmuted');
        if (groupMuteButton) groupMuteButton.classList.remove('muted').add('unmuted');
    }
}

function toggleMuteNonGroup() {
    const muteNonGroupButton = document.getElementById('mute-non-group');
    if (muteNonGroupButton.classList.contains('muted')) {
        ws.send(JSON.stringify({ type: 'unmute_non_group' }));
    } else {
        ws.send(JSON.stringify({ type: 'mute_non_group' }));
    }
}

// -------------------- SECCIÓN: Grupos --------------------
function createGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupId, is_private: isPrivate }));
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
    }
}

function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        localStorage.removeItem('groupId');
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('logout-button').style.display = 'block';
        updateSwipeHint();
    }
}

function checkGroupStatus() {
    const groupId = localStorage.getItem('groupId');
    if (groupId && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'check_group', group_id: groupId }));
    }
}

// -------------------- SECCIÓN: Usuarios --------------------
function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) return;

    usersDiv.innerHTML = `Usuarios conectados: ${count}<br>`;
    groupUsersDiv.innerHTML = `Usuarios conectados: ${list.filter(user => user.group_id === currentGroup).length}<br>`;

    const userList = document.createElement('div');
    userList.className = 'user-list';
    const groupUserList = document.createElement('div');
    groupUserList.className = 'user-list';

    list.forEach(user => {
        const userId = `${user.name}_${user.function}`;
        const userDiv = document.createElement('div');
        userDiv.className = 'user-item';
        if (user.group_id === currentGroup) userDiv.classList.add('in-group');
        const muteButton = document.createElement('button');
        muteButton.className = 'mute-button';
        muteButton.textContent = mutedUsers.has(userId) ? '🔇' : '🔊';
        muteButton.onclick = () => toggleMuteUser(userId, muteButton);
        userDiv.appendChild(muteButton);
        userDiv.appendChild(document.createTextNode(` ${user.name} (${user.function})`));
        userList.appendChild(userDiv);

        if (user.group_id === currentGroup) {
            groupUserList.appendChild(userDiv.cloneNode(true));
        }
    });

    usersDiv.appendChild(userList);
    groupUsersDiv.appendChild(groupUserList);
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = '🔊';
        ws.send(JSON.stringify({ type: 'unmute_user', target_user_id: userId }));
    } else {
        mutedUsers.add(userId);
        button.textContent = '🔇';
        ws.send(JSON.stringify({ type: 'mute_user', target_user_id: userId }));
    }
}

// -------------------- SECCIÓN: Navegación y gestos --------------------
function showRadar() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    document.getElementById('logout-button').style.display = 'none';
    if (!map) initMap();
    map.invalidateSize();
}

function backToMainFromRadar() {
    document.getElementById('radar-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    document.getElementById('logout-button').style.display = 'block';
    updateSwipeHint();
}

function showHistory() {
    fetch('/history')
        .then(response => response.json())
        .then(data => {
            const historyList = document.getElementById('history-list');
            if (!historyList) return;
            historyList.innerHTML = '';
            data.forEach(msg => {
                const msgDiv = document.createElement('div');
                msgDiv.className = 'chat-message';
                const localTime = new Date(`1970-01-01T${msg.timestamp}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${msg.text}`;
                const audioBlob = base64ToBlob(msg.audio, 'audio/webm');
                if (audioBlob) msgDiv.onclick = () => playAudio(audioBlob);
                historyList.appendChild(msgDiv);
            });
            document.getElementById('main').style.display = 'none';
            document.getElementById('history-screen').style.display = 'block';
            document.getElementById('logout-button').style.display = 'none';
        })
        .catch(err => {
            console.error('Error al cargar historial:', err);
            const historyList = document.getElementById('history-list');
            if (historyList) historyList.innerHTML = '<div>Error al cargar el historial</div>';
        });
}

function backToMain() {
    document.getElementById('history-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    document.getElementById('logout-button').style.display = 'block';
    updateSwipeHint();
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (!swipeHint || !returnToGroupBtn) return;
    if (currentGroup) {
        if (document.getElementById('main').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la derecha para ir al grupo';
            returnToGroupBtn.style.display = 'block';
        } else if (document.getElementById('group-screen').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la izquierda para volver';
            returnToGroupBtn.style.display = 'none';
        } else {
            swipeHint.style.display = 'none';
            returnToGroupBtn.style.display = 'none';
        }
    } else {
        swipeHint.style.display = 'none';
        returnToGroupBtn.style.display = 'none';
    }
}

function returnToGroup() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('group-screen').style.display = 'block';
    updateSwipeHint();
}

document.addEventListener('touchstart', e => {
    if (!isSwiping) startX = e.touches[0].clientX;
});

document.addEventListener('touchmove', e => {
    if (!isSwiping) currentX = e.touches[0].clientX;
});

document.addEventListener('touchend', e => {
    if (isSwiping) return;
    const deltaX = currentX - startX;
    if (Math.abs(deltaX) > 50) {
        isSwiping = true;
        if (deltaX > 0 && document.getElementById('group-screen').style.display === 'block') {
            document.getElementById('group-screen').classList.add('slide-right');
            setTimeout(() => {
                document.getElementById('group-screen').style.display = 'none';
                document.getElementById('main').style.display = 'block';
                document.getElementById('group-screen').classList.remove('slide-right');
                document.getElementById('logout-button').style.display = 'block';
                updateSwipeHint();
                isSwiping = false;
            }, 300);
        } else if (deltaX < 0 && document.getElementById('main').style.display === 'block' && currentGroup) {
            document.getElementById('main').classList.add('slide-left');
            setTimeout(() => {
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                document.getElementById('main').classList.remove('slide-left');
                updateSwipeHint();
                isSwiping = false;
            }, 300);
        } else {
            isSwiping = false;
        }
    } else {
        isSwiping = false;
    }
});

// -------------------- SECCIÓN: Cierre de sesión --------------------
function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'logout', sessionToken: localStorage.getItem('sessionToken') }));
    }
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (mediaRecorder) mediaRecorder.stop();
    if (groupMediaRecorder) groupMediaRecorder.stop();
    localStorage.clear();
    currentGroup = null;
    mutedUsers.clear();
    if (ws) ws.close();
    clearInterval(reconnectInterval);
    stopPing();
    document.getElementById('register').style.display = 'block';
    document.getElementById('main').style.display = 'none';
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'none';
    window.location.href = '/register-form';
}

// -------------------- SECCIÓN: Funciones auxiliares --------------------
function base64ToBlob(base64, mime) {
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([arrayBuffer], { type: mime });
    } catch (err) {
        console.error('Error al convertir Base64 a Blob:', err);
        return null;
    }
}

// -------------------- SECCIÓN: Event listeners adicionales --------------------
// -------------------- SECCIÓN: Event listeners adicionales --------------------
document.addEventListener('click', unlockAudio, { once: true });

// Manejar redimensionamiento de la ventana para el mapa
window.addEventListener('resize', () => {
    if (map) {
        map.invalidateSize();
        console.log('Mapa redimensionado');
    }
});

// Detectar cambios en la conexión a internet
window.addEventListener('online', () => {
    console.log('Conexión a internet restaurada');
    const sessionToken = localStorage.getItem('sessionToken');
    if (sessionToken && (!ws || ws.readyState !== WebSocket.OPEN)) {
        connectWebSocket(sessionToken);
    }
});

window.addEventListener('offline', () => {
    console.log('Sin conexión a internet');
    if (ws) {
        ws.close();
        stopPing();
    }
    alert('Se perdió la conexión a internet. Las funcionalidades estarán limitadas.');
});

// Atajos de teclado para acciones comunes
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return; // Ignorar si está en un input
    if (e.key === 't' && document.getElementById('main').style.display === 'block') {
        toggleTalk();
        e.preventDefault();
    } else if (e.key === 'g' && document.getElementById('group-screen').style.display === 'block') {
        toggleGroupTalk();
        e.preventDefault();
    } else if (e.key === 'm') {
        toggleMute();
        e.preventDefault();
    } else if (e.key === 'r' && document.getElementById('main').style.display === 'block') {
        showRadar();
        e.preventDefault();
    } else if (e.key === 'h' && document.getElementById('main').style.display === 'block') {
        showHistory();
        e.preventDefault();
    } else if (e.key === 'Escape') {
        if (document.getElementById('radar-screen').style.display === 'block') {
            backToMainFromRadar();
        } else if (document.getElementById('history-screen').style.display === 'block') {
            backToMain();
        } else if (document.getElementById('group-screen').style.display === 'block') {
            returnToGroup();
        }
        e.preventDefault();
    }
});

// Prevenir acciones predeterminadas en gestos táctiles para evitar zooms no deseados
document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 && map) {
        e.preventDefault(); // Evitar zoom con dos dedos en el mapa
    }
}, { passive: false });

// Actualizar la hora en la interfaz cada minuto
function updateClock() {
    const clockElement = document.getElementById('clock');
    if (clockElement) {
        clockElement.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
}
setInterval(updateClock, 60000);
updateClock(); // Ejecutar inmediatamente

// Limpiar recursos al cerrar la ventana
window.addEventListener('beforeunload', () => {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    if (mediaRecorder) {
        mediaRecorder.stop();
    }
    if (groupMediaRecorder) {
        groupMediaRecorder.stop();
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'logout', sessionToken: localStorage.getItem('sessionToken') }));
        ws.close();
    }
    stopPing();
});

// -------------------- SECCIÓN: Inicialización final --------------------
function initializeApp() {
    // Verificar soporte para APIs necesarias
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Este navegador no soporta grabación de audio.');
        document.getElementById('talk').disabled = true;
        document.getElementById('group-talk').disabled = true;
    }

    // Inicializar mapa si está en la pantalla de radar
    if (document.getElementById('radar-screen').style.display === 'block') {
        initMap();
    }

    // Restaurar estado de muteo desde localStorage (opcional)
    const storedMutedUsers = localStorage.getItem('mutedUsers');
    if (storedMutedUsers) {
        mutedUsers = new Set(JSON.parse(storedMutedUsers));
    }

    console.log('Aplicación inicializada');
}

// Ejecutar inicialización después de cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});
