package com.ammambouy.steelfrontier;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String BASE_URL = "https://steel-frontier.onrender.com";
    private static final String INDEX_URL = BASE_URL + "/index.html";
    private static final String SFX_API = BASE_URL + "/api/sfx";
    private static final String MUSIC_API = BASE_URL + "/api/music";
    private static final long UPDATE_INTERVAL_MS = 5 * 60 * 1000L;
    private static final String GITHUB_RELEASES_API = "https://api.github.com/repos/ammambouy-ux/Tank-game/releases/latest";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private WebView webView;
    private File webRoot;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean updateDialogVisible = false;
    private volatile LocalLanServer lanServer;
    private static final int REQUEST_LAN_PERMISSION = 7101;
    private volatile boolean pendingLanPermission = false;

    private final Runnable periodicUpdateCheck = this::runPeriodicUpdateCheck;

    private void runPeriodicUpdateCheck() {
        checkForUpdate(false);
        handler.postDelayed(periodicUpdateCheck, UPDATE_INTERVAL_MS);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        hideSystemUi();

        prefs = getSharedPreferences("steel_frontier", MODE_PRIVATE);
        webRoot = new File(getFilesDir(), "www");

        try {
            ensureBundledAssets();
        } catch (IOException e) {
            Toast.makeText(this, "Не удалось подготовить файлы игры", Toast.LENGTH_LONG).show();
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(20, 26, 16));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new LanBridge(), "AndroidLan");

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);

        setContentView(webView);

        File index = new File(webRoot, "index.html");
        if (index.isFile()) {
            webView.loadUrl(index.toURI().toString());
        } else {
            Toast.makeText(this, "Файл игры не найден", Toast.LENGTH_LONG).show();
        }

        handler.postDelayed(periodicUpdateCheck, 20_000L);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        handler.postDelayed(() -> checkForUpdate(false), 2500L);
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){var b=document.getElementById('pb');if(b){b.click();return 'pause';}return 'none';})()",
                null
        );
    }

    private void ensureBundledAssets() throws IOException {
        File index = new File(webRoot, "index.html");
        if (!index.isFile()) {
            copyAssetTree("www", webRoot);
            return;
        }

        String bundledVersion;
        String installedVersion;
        try (InputStream in = getAssets().open("www/index.html")) {
            bundledVersion = readGameVersion(in);
        }
        try (InputStream in = new FileInputStream(index)) {
            installedVersion = readGameVersion(in);
        }

        // When an APK is updated, replace an older cached WebView game with the
        // newer bundled copy. Keep a newer hot-updated game if it is already present.
        if (isNewerVersion(bundledVersion, installedVersion)) {
            copyAssetTree("www", webRoot);
        }
    }

    private String readGameVersion(InputStream source) throws IOException {
        try (InputStream in = source; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            String content = new String(out.toByteArray(), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("GAME_VERSION\\s*=\\s*['\\\"]([^'\\\"]+)['\\\"]").matcher(content);
            return m.find() ? m.group(1) : "0.0.0";
        }
    }

    private void copyAssetTree(String assetPath, File outDir) throws IOException {
        String[] children = getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            File parent = outDir.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("mkdir failed: " + parent);
            }
            try (InputStream in = getAssets().open(assetPath);
                 BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(outDir))) {
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
            return;
        }
        if (!outDir.exists() && !outDir.mkdirs()) throw new IOException("mkdir failed: " + outDir);
        for (String child : children) {
            copyAssetTree(assetPath + "/" + child, new File(outDir, child));
        }
    }

    private void checkForUpdate(boolean userRequested) {
        checkForApkUpdate();
        if (!hasNetwork()) {
            if (userRequested) Toast.makeText(this, "Нет подключения к интернету", Toast.LENGTH_SHORT).show();
            return;
        }

        io.execute(() -> {
            try {
                RemoteIndex remote = fetchRemoteIndex();
                File local = new File(webRoot, "index.html");
                if (!local.isFile()) return;

                String localHash = sha256(local);
                String dismissed = prefs.getString("dismissed_hash", "");
                if (!isNewerVersion(remote.version, getInstalledVersion()) && !remote.hash.equalsIgnoreCase(localHash) && !remote.hash.equals(dismissed)) {
                    runOnUiThread(() -> showUpdateDialog(remote));
                }
            } catch (Exception ignored) {
                // Network/Render cold start: keep the local game running.
            }
        });
    }

    private String getInstalledVersion() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "0.0.0" : info.versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private void checkForApkUpdate() {
        if (!hasNetwork() || updateDialogVisible) return;
        io.execute(() -> {
            try {
                ApkRelease release = fetchLatestRelease();
                if (!isNewerVersion(release.version, getInstalledVersion())) return;
                String dismissed = prefs.getString("dismissed_apk_version", "");
                if (release.version.equals(dismissed)) return;
                runOnUiThread(() -> showApkUpdateDialog(release));
            } catch (Exception ignored) {
            }
        });
    }

    private ApkRelease fetchLatestRelease() throws Exception {
        String json = new String(httpGet(GITHUB_RELEASES_API), StandardCharsets.UTF_8);
        org.json.JSONObject root = new org.json.JSONObject(json);
        String version = root.optString("tag_name", "").replaceFirst("^[vV]", "").trim();
        org.json.JSONArray assets = root.optJSONArray("assets");
        String apkUrl = "";
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                org.json.JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;
                String name = asset.optString("name", "");
                if (name.toLowerCase(Locale.US).endsWith(".apk")) {
                    apkUrl = asset.optString("browser_download_url", "");
                    break;
                }
            }
        }
        if (version.isEmpty() || apkUrl.isEmpty()) throw new IOException("No installable APK release");
        return new ApkRelease(version, apkUrl);
    }

    private boolean isNewerVersion(String remote, String local) {
        int[] r = parseVersion(remote);
        int[] l = parseVersion(local);
        for (int i = 0; i < Math.max(r.length, l.length); i++) {
            int rv = i < r.length ? r[i] : 0;
            int lv = i < l.length ? l[i] : 0;
            if (rv != lv) return rv > lv;
        }
        return false;
    }

    private int[] parseVersion(String v) {
        String clean = v == null ? "" : v.trim().replaceFirst("^[vV]", "");
        String[] parts = clean.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                Matcher m = Pattern.compile("\\d+").matcher(parts[i]);
                out[i] = m.find() ? Integer.parseInt(m.group()) : 0;
            } catch (Exception ignored) {
                out[i] = 0;
            }
        }
        return out;
    }

    private void showApkUpdateDialog(ApkRelease release) {
        if (isFinishing() || updateDialogVisible) return;
        updateDialogVisible = true;
        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление")
                .setMessage("Установлена версия " + getInstalledVersion()
                        + ". Доступна новая версия " + release.version
                        + ".\n\nОбновить сейчас или сделать это позже?")
                .setNegativeButton("Позже", (d, w) -> {
                    prefs.edit().putString("dismissed_apk_version", release.version).apply();
                    updateDialogVisible = false;
                })
                .setPositiveButton("Обновить", (d, w) -> {
                    updateDialogVisible = false;
                    downloadAndInstallApk(release);
                })
                .setOnCancelListener(d -> updateDialogVisible = false)
                .show();
    }

    private void downloadAndInstallApk(ApkRelease release) {
        if (android.os.Build.VERSION.SDK_INT >= 26
                && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("Разрешение на установку")
                    .setMessage("Разреши этому приложению устанавливать APK из неизвестных источников.")
                    .setNegativeButton("Отмена", null)
                    .setPositiveButton("Открыть настройки", (d, w) -> {
                        try {
                            startActivity(new android.content.Intent(
                                    android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    android.net.Uri.parse("package:" + getPackageName())));
                        } catch (Exception e) {
                            startActivity(new android.content.Intent(
                                    android.provider.Settings.ACTION_SECURITY_SETTINGS));
                        }
                    })
                    .show();
            return;
        }

        Toast.makeText(this, "Загрузка обновления " + release.version + "…", Toast.LENGTH_SHORT).show();

        android.app.DownloadManager.Request req =
                new android.app.DownloadManager.Request(android.net.Uri.parse(release.apkUrl));
        req.setTitle("Стальной рубеж " + release.version);
        req.setDescription("Загрузка обновления");
        req.setMimeType(APK_MIME);
        req.setNotificationVisibility(
                android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalFilesDir(
                this,
                android.os.Environment.DIRECTORY_DOWNLOADS,
                "SteelFrontier-" + release.version + ".apk");

        android.app.DownloadManager dm =
                (android.app.DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        long downloadId = dm.enqueue(req);
        handler.postDelayed(() -> waitForApkDownload(dm, downloadId, release), 500L);
    }

    private void waitForApkDownload(android.app.DownloadManager dm, long id, ApkRelease release) {
        android.database.Cursor cursor = null;
        try {
            cursor = dm.query(new android.app.DownloadManager.Query().setFilterById(id));
            if (cursor == null || !cursor.moveToFirst()) {
                handler.postDelayed(() -> waitForApkDownload(dm, id, release), 800L);
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(
                    android.app.DownloadManager.COLUMN_STATUS));
            if (status == android.app.DownloadManager.STATUS_PENDING
                    || status == android.app.DownloadManager.STATUS_RUNNING) {
                handler.postDelayed(() -> waitForApkDownload(dm, id, release), 800L);
                return;
            }
            if (status != android.app.DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(this, "Не удалось скачать обновление", Toast.LENGTH_LONG).show();
                return;
            }

            String uriString = cursor.getString(cursor.getColumnIndexOrThrow(
                    android.app.DownloadManager.COLUMN_LOCAL_URI));
            if (uriString == null || uriString.isEmpty()) {
                Toast.makeText(this, "Файл обновления не найден", Toast.LENGTH_LONG).show();
                return;
            }

            android.content.Intent intent = new android.content.Intent(
                    android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse(uriString));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
            prefs.edit().putString("dismissed_apk_version", release.version).apply();
        } catch (Exception e) {
            Toast.makeText(this, "Android не смог открыть установщик APK", Toast.LENGTH_LONG).show();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private boolean hasNetwork() {
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            android.net.Network n = cm != null ? cm.getActiveNetwork() : null;
            return n != null;
        } catch (Exception e) {
            return true;
        }
    }

    private RemoteIndex fetchRemoteIndex() throws Exception {
        byte[] data = httpGet(INDEX_URL);
        String html = new String(data, StandardCharsets.UTF_8);
        String version = "новая версия";
        Matcher m = Pattern.compile("const\\s+GAME_VERSION\\s*=\\s*['\\\"]([^'\\\"]+)").matcher(html);
        if (m.find()) version = m.group(1);
        return new RemoteIndex(version, sha256(data), html);
    }

    private void showUpdateDialog(RemoteIndex remote) {
        if (isFinishing() || updateDialogVisible) return;
        updateDialogVisible = true;

        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление")
                .setMessage(
                        "Доступна версия " + remote.version
                                + ".\n\nОбновление перезапустит игру. Текущий забег будет завершён, "
                                + "а сохранённые гараж/монеты останутся."
                )
                .setNegativeButton("Позже", (d, w) -> {
                    prefs.edit().putString("dismissed_hash", remote.hash).apply();
                    updateDialogVisible = false;
                })
                .setPositiveButton("Обновить", (d, w) -> {
                    updateDialogVisible = false;
                    applyRemoteUpdate(remote);
                })
                .setOnCancelListener(d -> updateDialogVisible = false)
                .show();
    }

    private void applyRemoteUpdate(RemoteIndex remote) {
        io.execute(() -> {
            try {
                File tempIndex = new File(webRoot, "index.html.part");
                writeBytes(tempIndex, remote.bytes());

                syncAudioPack(SFX_API, new File(webRoot, "PackSFXTanks"));
                syncAudioPack(MUSIC_API, new File(webRoot, "PackMusic"));

                File index = new File(webRoot, "index.html");
                if (!tempIndex.renameTo(index)) {
                    writeBytes(index, remote.bytes());
                    tempIndex.delete();
                }

                prefs.edit().remove("dismissed_hash").apply();

                runOnUiThread(() -> {
                    Toast.makeText(this, "Обновление установлено", Toast.LENGTH_SHORT).show();
                    webView.reload();
                });
            } catch (Exception e) {
                runOnUiThread(() ->
                        Toast.makeText(this, "Не удалось установить обновление", Toast.LENGTH_LONG).show());
            }
        });
    }

    private void syncAudioPack(String manifestUrl, File dir) throws Exception {
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");

        JSONArray arr = new JSONArray(new String(httpGet(manifestUrl), StandardCharsets.UTF_8));
        String prefix = manifestUrl.equals(SFX_API) ? "/PackSFXTanks/" : "/PackMusic/";

        for (int i = 0; i < arr.length(); i++) {
            String name = arr.optString(i, "").trim();
            if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) continue;
            byte[] data = httpGet(BASE_URL + prefix + name);
            writeBytes(new File(dir, name), data);
        }
    }

    private byte[] httpGet(String urlString) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlString).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", "SteelFrontier-Android/1.0");
        c.setInstanceFollowRedirects(true);

        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code);

            try (InputStream in = new BufferedInputStream(c.getInputStream());
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    private void writeBytes(File file, byte[] data) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("mkdir failed: " + parent);
        try (BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
            out.write(data);
        }
    }

    private String sha256(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            return hex(md.digest());
        }
    }

    private String sha256(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return hex(md.digest(data));
    }

    private String hex(byte[] data) {
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }


    private final class LanBridge {
        @JavascriptInterface
        public void requestLanAccess() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
                    pendingLanPermission = true;
                    requestPermissions(new String[]{Manifest.permission.NEARBY_WIFI_DEVICES}, REQUEST_LAN_PERMISSION);
                    return;
                }
                deliverLanPermission(true);
            });
        }

        @JavascriptInterface
        public boolean startLanHost() {
            synchronized (MainActivity.this) {
                try {
                    if (lanServer != null && lanServer.isRunningReady()) return true;
                    if (lanServer != null) {
                        LocalLanServer stale = lanServer;
                        lanServer = null;
                        new Thread(stale::shutdownLocal, "lan-stale-stop").start();
                    }
                    LocalLanServer server = new LocalLanServer();
                    lanServer = server;
                    server.start();
                    if (server.awaitStarted(1800L)) return true;
                    lanServer = null;
                    new Thread(server::shutdownLocal, "lan-start-failed-stop").start();
                    return false;
                } catch (Exception e) {
                    lanServer = null;
                    return false;
                }
            }
        }

        @JavascriptInterface
        public void stopLanHost() {
            final LocalLanServer server;
            synchronized (MainActivity.this) {
                server = lanServer;
                lanServer = null;
            }
            if (server != null) new Thread(server::shutdownLocal, "lan-stop").start();
        }

        @JavascriptInterface
        public void scanLanRooms() {
            io.execute(() -> {
                JSONArray rooms = LocalLanServer.scanForRooms();
                String quoted = JSONObject.quote(rooms.toString());
                handler.post(() -> {
                    if (webView != null) {
                        webView.evaluateJavascript("window.onLanRooms&&window.onLanRooms(" + quoted + ");", null);
                    }
                });
            });
        }
    }

    private void deliverLanPermission(boolean granted) {
        if (webView == null) return;
        webView.evaluateJavascript("window.onLanPermission&&window.onLanPermission(" + (granted ? "true" : "false") + ");", null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_LAN_PERMISSION && pendingLanPermission) {
            pendingLanPermission = false;
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            deliverLanPermission(granted);
        }
    }

    @Override
    protected void onDestroy() {
        LocalLanServer server = lanServer;
        lanServer = null;
        if (server != null) new Thread(server::shutdownLocal, "lan-destroy").start();
        super.onDestroy();
    }

    private static final class RemoteIndex {
        final String version;
        final String hash;
        final String html;

        RemoteIndex(String version, String hash, String html) {
            this.version = version;
            this.hash = hash;
            this.html = html;
        }

        byte[] bytes() {
            return html.getBytes(StandardCharsets.UTF_8);
        }
    }
    private static final class ApkRelease {
        final String version;
        final String apkUrl;
        ApkRelease(String version, String apkUrl) {
            this.version = version;
            this.apkUrl = apkUrl;
        }
    }
}
