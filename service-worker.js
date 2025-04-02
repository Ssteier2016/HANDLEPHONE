self.addEventListener("install", (event) => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    clients.claim();
});

let socket;

function connectSocket() {
    socket = new WebSocket(self.location.origin.replace(/^http/, "ws") + "/socket.io/?EIO=4&transport=websocket");

    socket.onmessage = (event) => {
        self.clients.matchAll().then((clients) => {
            clients.forEach((client) => {
                client.postMessage({ type: "NEW_MESSAGE", data: event.data });
            });
        });
    };

    socket.onclose = () => {
        setTimeout(connectSocket, 3000); // Reintentar en 3 segundos si se desconecta
    };
}

connectSocket();
