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
        if (!isMuted) {
            self.clients.matchAll().then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({ type: "NEW_MESSAGE", data: event.data });
                });
            });
        }
    };

    socket.onclose = () => {
        setTimeout(connectSocket, 3000); // Reintentar en 3 segundos si se desconecta
    };
}

connectSocket();

self.addEventListener("message", async (event) => {
    if (event.data.type === "START_RECORDING") {
        try {
            let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            let mediaRecorder = new MediaRecorder(stream);
            let audioChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                let audioBlob = new Blob(audioChunks, { type: "audio/wav" });
                let reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    socket.send(JSON.stringify({ type: "AUDIO_MESSAGE", audio: reader.result }));
                };
            };

            mediaRecorder.start();
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
