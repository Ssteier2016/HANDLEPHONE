self.addEventListener("install", (event) => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    clients.claim();
});

let socket;
let isMuted = false;

function connectSocket() {
    socket = new WebSocket(self.location.origin.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket");

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (!isMuted && data.type === "AUDIO_MESSAGE") {
            self.clients.matchAll().then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({ type: "NEW_AUDIO", audio: data.audio });
                });
            });
        }
    };

    socket.onclose = () => {
        setTimeout(connectSocket, 3000); // Reintentar en 3 segundos
    };
}

connectSocket();

self.addEventListener("message", async (event) => {
    if (event.data.type === "START_RECORDING") {
        try {
            let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            let mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
            let audioChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                audioChunks.push(e.data);
                socket.send(JSON.stringify({ type: "AUDIO_CHUNK", audio: e.data }));
            };

            mediaRecorder.onstop = () => {
                let audioBlob = new Blob(audioChunks, { type: "audio/webm" });
                let reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    socket.send(JSON.stringify({ type: "AUDIO_MESSAGE", audio: reader.result }));
                };
                stream.getTracks().forEach(track => track.stop()); // Apagar micrófono
            };

            mediaRecorder.start(100); // Enviar chunks cada 100ms para tiempo real
            self.mediaRecorder = mediaRecorder;
        } catch (err) {
            console.error("Error al acceder al micrófono:", err);
        }
    } else if (event.data.type === "STOP_RECORDING") {
        if (self.mediaRecorder && self.mediaRecorder.state === "recording") {
            self.mediaRecorder.stop();
        }
    } else if (event.data.type === "TOGGLE_MUTE") {
        isMuted = event.data.mute;
    }
});
    
