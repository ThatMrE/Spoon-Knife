package io.github.thatmre.sociovia;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Path safety for the phone-hosted server, mirroring the Node server's rules. */
public class HttpRoutingTest {

  @Test
  public void mapsTheClientOntoBundledAssets() {
    assertEquals("web/index.html", HttpRouting.assetPath("/"));
    assertEquals("web/index.html", HttpRouting.assetPath("/index.html"));
    assertEquals("web/js/app.js", HttpRouting.assetPath("/js/app.js"));
    assertEquals("web/css/style.css", HttpRouting.assetPath("/css/style.css"));
  }

  @Test
  public void servesTheSharedAndCoreModules() {
    // The hosting phone must serve the same module graph the Node server does,
    // or the client cannot import the protocol and the host cannot import the
    // game rules.
    assertEquals("web/shared/protocol.js", HttpRouting.assetPath("/shared/protocol.js"));
    assertEquals("web/core/rooms.js", HttpRouting.assetPath("/core/rooms.js"));
    assertEquals("web/host/bridge.js", HttpRouting.assetPath("/host/bridge.js"));
  }

  @Test
  public void stripsQueryAndFragment() {
    assertEquals("web/css/style.css", HttpRouting.assetPath("/css/style.css?v=2"));
    assertEquals("web/css/style.css", HttpRouting.assetPath("/css/style.css#top"));
  }

  @Test
  public void neverEscapesTheAssetRoot() {
    String[] attacks = {
        "/../secrets",
        "/../../etc/passwd",
        "/js/../../etc/passwd",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/core/../../../x",
        "/./../x",
        "/a/b/../../../../../../etc/passwd",
    };
    for (String attack : attacks) {
      String resolved = HttpRouting.assetPath(attack);
      if (resolved == null) continue;
      assertTrue(attack + " escaped to " + resolved, resolved.startsWith(HttpRouting.ASSET_ROOT + "/"));
      assertFalse(attack + " kept a parent segment", resolved.contains(".."));
    }
  }

  @Test
  public void stillResolvesParentSegmentsInsideTheTree() {
    assertEquals("web/css/style.css", HttpRouting.assetPath("/js/../css/style.css"));
  }

  @Test
  public void refusesWhatItCannotUnderstand() {
    assertNull(HttpRouting.assetPath("/%zz"));
    assertNull(HttpRouting.assetPath("js/app.js"));
    assertNull(HttpRouting.assetPath(""));
    assertNull(HttpRouting.assetPath(null));
  }

  @Test
  public void labelsContentTypesTheBrowserNeeds() {
    // A wrong type on a module means the WebView refuses to execute it.
    assertEquals("text/javascript; charset=utf-8", HttpRouting.contentType("web/js/app.js"));
    assertEquals("text/html; charset=utf-8", HttpRouting.contentType("web/index.html"));
    assertEquals("text/css; charset=utf-8", HttpRouting.contentType("web/css/style.css"));
    assertEquals("application/octet-stream", HttpRouting.contentType("web/x.bin"));
  }

  @Test
  public void parsesRequestLines() {
    assertEquals("GET", HttpRouting.methodFromRequestLine("GET /ws HTTP/1.1"));
    assertEquals("/ws", HttpRouting.pathFromRequestLine("GET /ws HTTP/1.1"));
    assertNull(HttpRouting.pathFromRequestLine("garbage"));
    assertNull(HttpRouting.pathFromRequestLine(null));
  }
}
