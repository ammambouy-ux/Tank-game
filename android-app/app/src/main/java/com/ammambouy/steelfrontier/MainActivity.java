package com.ammambouy.steelfrontier;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;

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

    private WebView webView;
    private File webRoot;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean updateDialogVisible = false;

    private final Runnable periodicUpdateCheck = () -> {
        checkForUpdate(false);
        handler.postDelayed(periodicUpdateCheck, UPDATE_INTERVAL_MS);
    };

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

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
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
        if (index.isFile()) return;
        copyAssetTree("www", webRoot);
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
        for (String child : children) copyAssetTree(assetPath + "/" + child, new File(outDir, child));
    }

    private void checkForUpdate(boolean userRequested) {
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
                if (!remote.hash.equalsIgnoreCase(localHash) && !remote.hash.equals(dismissed)) {
                    runOnUiThread(() -> showUpdateDialog(remote));
                }
            } catch (Exception ignored) {
            }
        });
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
                .setMessage("Доступна новая версия игры: " + remote.version
                        + "\n\nОбновление перезапустит игру. Текущий прогресс сохранён.")
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
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("mkdir failed");
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

    private static final class RemoteIndex {
        final String version;
        final String hash;
        final String html;

        RemoteIndex(String version, String hash, String html) {
            this.version = version;
            this.hash = hash;
            this.html = html;
        }

        byte[] bytes() { return html.getBytes(StandardCharsets.UTF_8); }
    }
}
