package com.ammambouy.steelfrontier;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class LocalLanServer extends WebSocketServer {
    public static final int WS_PORT = 32123;
    public static final int DISCOVERY_PORT = 32124;
    private static final String DISCOVER = "STEEL_FRONTIER_DISCOVER_V1";
    private static final String ROOM_PREFIX = "STEEL_FRONTIER_ROOM_V1|";
    private static final int MAX_PLAYERS = 4;
    private static final int MIN_PLAYERS = 2;
    private static final String CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    private final CountDownLatch startedLatch = new CountDownLatch(1);
    private final AtomicInteger nextId = new AtomicInteger(1);
    private final Map<WebSocket, Client> clients = new ConcurrentHashMap<>();
    private final Object stateLock = new Object();
    private final Random random = new Random();
    private volatile boolean runningReady = false;
    private volatile boolean startFailed = false;
    private volatile boolean discoveryRunning = false;
    private volatile DatagramSocket discoverySocket;
    private volatile Thread discoveryThread;
    private volatile JSONObject discoveryRoom;
    private Lobby lobby;

    public LocalLanServer() {
        super(new InetSocketAddress("0.0.0.0", WS_PORT));
        setReuseAddr(true);
        setConnectionLostTimeout(25);
    }

    public boolean awaitStarted(long timeoutMs) {
        try {
            if (!startedLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return runningReady && !startFailed;
    }

    public boolean isRunningReady() {
        return runningReady && !startFailed;
    }

    @Override
    public void onStart() {
        runningReady = true;
        startedLatch.countDown();
        startDiscoveryResponder();
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        Client c = new Client(conn, nextId.getAndIncrement());
        clients.put(conn, c);
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        Client c = clients.get(conn);
        if (c == null || message == null || message.length() > 100000) return;
        final JSONObject m;
        try {
            m = new JSONObject(message);
        } catch (JSONException e) {
            return;
        }
        synchronized (stateLock) {
            if (!conn.isOpen()) return;
            String type = m.optString("t", "");
            switch (type) {
                case "hello":
                    c.name = clean(m.optString("pn", c.name), 14, c.name);
                    c.tank = clean(m.optString("tk", c.tank), 12, c.tank);
                    send(c, json("t", "hi", "id", c.id, "online", connectedCount(),
                            "resume", "", "resumed", false));
                    break;
                case "list":
                    JSONArray lobbies = new JSONArray();
                    if (lobby != null && !lobby.players.isEmpty()) {
                        lobbies.put(json("code", lobby.code, "name", lobby.name,
                                "n", lobby.players.size(), "max", MAX_PLAYERS,
                                "lock", !lobby.pass.isEmpty(), "started", lobby.started));
                    }
                    send(c, json("t", "list", "online", connectedCount(), "lobbies", lobbies));
                    break;
                case "create":
                    if (lobby != null && !lobby.players.isEmpty()) {
                        send(c, json("t", "err", "msg", "На этом устройстве уже есть активное лобби"));
                        break;
                    }
                    c.name = clean(m.optString("pn", c.name), 14, c.name);
                    c.tank = clean(m.optString("tk", c.tank), 12, c.tank);
                    lobby = new Lobby(newCode(), clean(m.optString("name", "Лобби"), 20, "Лобби"),
                            clean(m.optString("pass", ""), 16, ""), c);
                    c.lobby = lobby;
                    refreshDiscoveryRoom();
                    send(c, lobbyInfo(lobby));
                    break;
                case "join": {
                    Lobby l = lobby;
                    String code = m.optString("code", "").trim().toUpperCase();
                    if (l == null || !l.code.equals(code)) {
                        send(c, json("t", "err", "msg", "Лобби с таким кодом не найдено"));
                        break;
                    }
                    if (l.started) {
                        send(c, json("t", "err", "msg", "Игра в этом лобби уже началась"));
                        break;
                    }
                    if (l.players.size() >= MAX_PLAYERS) {
                        send(c, json("t", "err", "msg", "Лобби заполнено (4/4)"));
                        break;
                    }
                    if (!l.pass.isEmpty() && !clean(m.optString("pass", ""), 16, "").equals(l.pass)) {
                        send(c, json("t", "err", "msg", "Неверный пароль"));
                        break;
                    }
                    if (c.lobby == l) {
                        send(c, lobbyInfo(l));
                        break;
                    }
                    if (c.lobby != null) leave(c);
                    c.name = clean(m.optString("pn", c.name), 14, c.name);
                    c.tank = clean(m.optString("tk", c.tank), 12, c.tank);
                    l.players.add(c);
                    c.lobby = l;
                    refreshDiscoveryRoom();
                    broadcast(l, lobbyInfo(l));
                    break;
                }
                case "leave":
                    leave(c);
                    break;
                case "start": {
                    Lobby l = c.lobby;
                    if (l == null || l.host != c.id || l.started) break;
                    if (l.players.size() < MIN_PLAYERS) {
                        send(c, json("t", "err", "msg", "Нужно минимум 2 игрока"));
                        break;
                    }
                    l.started = true;
                    refreshDiscoveryRoom();
                    broadcast(l, lobbyInfo(l));
                    broadcast(l, json("t", "start"));
                    break;
                }
                case "r": {
                    Lobby l = c.lobby;
                    JSONObject data = m.optJSONObject("d");
                    if (l == null || !l.started || data == null) break;
                    Object target = m.opt("to");
                    JSONObject packet = json("t", "r", "from", c.id, "d", data);
                    if ("all".equals(target)) {
                        for (Client player : new ArrayList<>(l.players)) if (player != c) send(player, packet);
                    } else {
                        Client receiver = null;
                        if ("host".equals(target)) {
                            for (Client player : l.players) if (player.id == l.host) { receiver = player; break; }
                        } else if (target instanceof Number) {
                            int id = ((Number) target).intValue();
                            for (Client player : l.players) if (player.id == id) { receiver = player; break; }
                        }
                        if (receiver != null && receiver != c) send(receiver, packet);
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Client c = clients.remove(conn);
        if (c == null) return;
        synchronized (stateLock) {
            leave(c);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (!runningReady) {
            startFailed = true;
            startedLatch.countDown();
        }
    }

    private void leave(Client c) {
        Lobby l = c.lobby;
        if (l == null) return;
        c.lobby = null;
        l.players.remove(c);
        if (l.players.isEmpty()) {
            if (lobby == l) lobby = null;
            refreshDiscoveryRoom();
            return;
        }
        if (l.host == c.id) {
            if (l.started) {
                for (Client player : new ArrayList<>(l.players)) {
                    player.lobby = null;
                    send(player, json("t", "end", "msg", "Хост вышел из игры"));
                }
                l.players.clear();
                if (lobby == l) lobby = null;
            } else {
                l.host = l.players.get(0).id;
                broadcast(l, lobbyInfo(l));
            }
        } else {
            broadcast(l, lobbyInfo(l));
            if (l.started) broadcast(l, json("t", "left", "id", c.id));
        }
        refreshDiscoveryRoom();
    }

    private JSONObject lobbyInfo(Lobby l) {
        JSONArray players = new JSONArray();
        for (Client p : l.players) {
            players.put(json("id", p.id, "name", p.name, "tk", p.tank,
                    "connected", p.ws != null && p.ws.isOpen()));
        }
        return json("t", "lobby", "code", l.code, "name", l.name, "lock", !l.pass.isEmpty(),
                "host", l.host, "started", l.started, "max", MAX_PLAYERS,
                "min", MIN_PLAYERS, "players", players);
    }

    private void broadcast(Lobby l, JSONObject packet) {
        for (Client p : new ArrayList<>(l.players)) send(p, packet);
    }

    private void send(Client c, JSONObject packet) {
        if (c == null || c.ws == null || !c.ws.isOpen()) return;
        try { c.ws.send(packet.toString()); } catch (Exception ignored) {}
    }

    private int connectedCount() {
        int n = 0;
        for (Client c : clients.values()) if (c.ws != null && c.ws.isOpen()) n++;
        return n;
    }

    private String newCode() {
        for (int tries = 0; tries < 100; tries++) {
            StringBuilder b = new StringBuilder(4);
            for (int i = 0; i < 4; i++) b.append(CODE_CHARS.charAt(random.nextInt(CODE_CHARS.length())));
            if (lobby == null || !lobby.code.equals(b.toString())) return b.toString();
        }
        return Integer.toString(random.nextInt(36 * 36 * 36 * 36), 36).toUpperCase();
    }

    private void refreshDiscoveryRoom() {
        Lobby l = lobby;
        if (l == null || l.players.isEmpty()) {
            discoveryRoom = null;
            return;
        }
        discoveryRoom = json("code", l.code, "name", l.name, "n", l.players.size(),
                "max", MAX_PLAYERS, "lock", !l.pass.isEmpty(), "started", l.started, "port", WS_PORT);
    }

    private void startDiscoveryResponder() {
        discoveryRunning = true;
        discoveryThread = new Thread(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket(null);
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                socket.setSoTimeout(500);
                discoverySocket = socket;
                byte[] data = new byte[1024];
                while (discoveryRunning && !socket.isClosed()) {
                    DatagramPacket request = new DatagramPacket(data, data.length);
                    try {
                        socket.receive(request);
                    } catch (SocketTimeoutException timeout) {
                        continue;
                    }
                    String message = new String(request.getData(), request.getOffset(), request.getLength(), StandardCharsets.UTF_8);
                    if (!DISCOVER.equals(message)) continue;
                    JSONObject room = discoveryRoom;
                    if (room == null) continue;
                    byte[] response = (ROOM_PREFIX + room.toString()).getBytes(StandardCharsets.UTF_8);
                    socket.send(new DatagramPacket(response, response.length, request.getAddress(), request.getPort()));
                }
            } catch (Exception ignored) {
            } finally {
                if (socket != null) socket.close();
                discoverySocket = null;
            }
        }, "steel-frontier-lan-discovery");
        discoveryThread.setDaemon(true);
        discoveryThread.start();
    }

    public void shutdownLocal() {
        discoveryRunning = false;
        DatagramSocket socket = discoverySocket;
        if (socket != null) socket.close();
        try { stop(1200); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    public static JSONArray scanForRooms() {
        Map<String, JSONObject> found = new LinkedHashMap<>();
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket(null);
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            socket.bind(new InetSocketAddress(0));
            socket.setSoTimeout(180);
            byte[] requestBytes = DISCOVER.getBytes(StandardCharsets.UTF_8);
            Set<InetAddress> broadcasts = broadcastAddresses();
            broadcasts.add(InetAddress.getByName("255.255.255.255"));
            long end = System.currentTimeMillis() + 2600L;
            long nextSend = 0L;
            byte[] receiveBuf = new byte[4096];
            while (System.currentTimeMillis() < end) {
                long now = System.currentTimeMillis();
                if (now >= nextSend) {
                    for (InetAddress address : broadcasts) {
                        try {
                            socket.send(new DatagramPacket(requestBytes, requestBytes.length, address, DISCOVERY_PORT));
                        } catch (IOException ignored) {}
                    }
                    nextSend = now + 500L;
                }
                DatagramPacket packet = new DatagramPacket(receiveBuf, receiveBuf.length);
                try {
                    socket.receive(packet);
                    String message = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
                    if (!message.startsWith(ROOM_PREFIX)) continue;
                    JSONObject room = new JSONObject(message.substring(ROOM_PREFIX.length()));
                    room.put("address", packet.getAddress().getHostAddress());
                    room.put("port", room.optInt("port", WS_PORT));
                    String key = room.optString("address", "") + ":" + room.optInt("port", WS_PORT) + "/" + room.optString("code", "");
                    found.put(key, room);
                } catch (SocketTimeoutException ignored) {
                } catch (JSONException ignored) {
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (socket != null) socket.close();
        }
        JSONArray result = new JSONArray();
        for (JSONObject room : found.values()) result.put(room);
        return result;
    }

    private static Set<InetAddress> broadcastAddresses() {
        Set<InetAddress> result = new HashSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface ni = interfaces.nextElement();
                try {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                } catch (SocketException ignored) { continue; }
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress local = ia.getAddress();
                    if (!(local instanceof Inet4Address) || local.isLoopbackAddress() || !local.isSiteLocalAddress()) continue;
                    InetAddress broadcast = ia.getBroadcast();
                    if (broadcast != null) result.add(broadcast);
                }
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    private static String clean(String value, int max, String fallback) {
        String cleaned = value == null ? "" : value.trim();
        cleaned = cleaned.replace("<", "").replace(">", "").replace("&", "")
                .replace("\"", "").replace("'", "");
        if (cleaned.length() > max) cleaned = cleaned.substring(0, max);
        return cleaned.isEmpty() ? fallback : cleaned;
    }

    private static JSONObject json(Object... values) {
        JSONObject obj = new JSONObject();
        for (int i = 0; i + 1 < values.length; i += 2) {
            try { obj.put(String.valueOf(values[i]), values[i + 1]); } catch (JSONException ignored) {}
        }
        return obj;
    }

    private static final class Client {
        final WebSocket ws;
        final int id;
        String name = "Игрок";
        String tank = "std";
        Lobby lobby;
        Client(WebSocket ws, int id) { this.ws = ws; this.id = id; }
    }

    private static final class Lobby {
        final String code;
        final String name;
        final String pass;
        final List<Client> players = new ArrayList<>();
        int host;
        boolean started;
        Lobby(String code, String name, String pass, Client hostClient) {
            this.code = code;
            this.name = name;
            this.pass = pass;
            this.host = hostClient.id;
            players.add(hostClient);
        }
    }
}
