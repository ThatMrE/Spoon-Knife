package io.github.thatmre.sociovia;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * URL-to-asset mapping and content types for the phone-hosted server.
 *
 * Pure, so the path-safety rules can be unit-tested on a plain JVM. The same
 * property matters here as in the Node server: a request must never be able to
 * climb out of the bundled web assets.
 */
public final class HttpRouting {

  /** Where the web client lives inside the APK's assets. */
  public static final String ASSET_ROOT = "web";

  private HttpRouting() {}

  /**
   * The asset path for a request path, or null if the request is unsafe.
   *
   * Relative segments are resolved rather than merely stripped, so no spelling
   * of "go up a directory" escapes the asset root.
   */
  public static String assetPath(String urlPath) {
    if (urlPath == null || urlPath.isEmpty()) return null;

    String path = urlPath;
    int cut = indexOfAny(path, "?#");
    if (cut >= 0) path = path.substring(0, cut);

    String decoded = percentDecode(path);
    if (decoded == null || decoded.indexOf('\0') >= 0) return null;
    if (!decoded.startsWith("/")) return null;

    // Resolve the path against root; ".." can never take us above it.
    String[] segments = decoded.split("/");
    StringBuilder resolved = new StringBuilder();
    int depth = 0;
    for (String segment : segments) {
      if (segment.isEmpty() || segment.equals(".")) continue;
      if (segment.equals("..")) {
        if (depth == 0) continue; // already at the root; stay there
        int lastSlash = resolved.lastIndexOf("/");
        resolved.setLength(lastSlash < 0 ? 0 : lastSlash);
        depth--;
        continue;
      }
      if (depth > 0) resolved.append('/');
      resolved.append(segment);
      depth++;
    }

    String relative = resolved.length() == 0 ? "index.html" : resolved.toString();
    // A directory request gets its index, matching the Node server.
    if (relative.endsWith("/")) relative = relative + "index.html";
    return ASSET_ROOT + "/" + relative;
  }

  /** Content type for an asset path. */
  public static String contentType(String path) {
    String lower = path.toLowerCase();
    if (lower.endsWith(".html")) return "text/html; charset=utf-8";
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
    if (lower.endsWith(".css")) return "text/css; charset=utf-8";
    if (lower.endsWith(".json")) return "application/json; charset=utf-8";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".webmanifest")) return "application/manifest+json";
    return "application/octet-stream";
  }

  /** The path part of a request line like "GET /js/app.js HTTP/1.1". */
  public static String pathFromRequestLine(String requestLine) {
    if (requestLine == null) return null;
    String[] parts = requestLine.split(" ");
    if (parts.length < 2) return null;
    return parts[1];
  }

  /** The method from a request line, uppercased. */
  public static String methodFromRequestLine(String requestLine) {
    if (requestLine == null) return null;
    String[] parts = requestLine.split(" ");
    if (parts.length < 1 || parts[0].isEmpty()) return null;
    return parts[0].toUpperCase();
  }

  /** Returns null on malformed escapes rather than guessing. */
  static String percentDecode(String text) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c != '%') {
        byte[] encoded = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
        out.write(encoded, 0, encoded.length);
        continue;
      }
      if (i + 2 >= text.length()) return null;
      int value;
      try {
        value = Integer.parseInt(text.substring(i + 1, i + 3), 16);
      } catch (NumberFormatException e) {
        return null;
      }
      out.write(value);
      i += 2;
    }
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  private static int indexOfAny(String text, String chars) {
    for (int i = 0; i < text.length(); i++) {
      if (chars.indexOf(text.charAt(i)) >= 0) return i;
    }
    return -1;
  }
}
