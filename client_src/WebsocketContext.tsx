import { createContext, useEffect, useState } from "react";

// https://websocket.org/guides/frameworks/react/#context-provider-one-connection-many-components
export const WebSocketContext = createContext<WebSocket | null>(null);

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [ws, setWs] = useState<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket("/api/websocket");

    socket.onopen = () => console.log("WebSocket connection established");
    socket.onclose = () => console.log("WebSocket connection closed");

    setWs(socket);

    return () => {
      socket.close();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={ws}>
      {children}
    </WebSocketContext.Provider>
  );
}
