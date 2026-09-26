package io.github.thatmre.sociovia;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The host splices client text into JavaScript source via evaluateJavascript,
 * and player names are whatever someone typed into their phone, so this is a
 * correctness boundary.
 */
public class JsStringTest {

  @Test
  public void quotesPlainText() {
    assertEquals("\"ADA\"", JsString.quote("ADA"));
    assertEquals("\"\"", JsString.quote(""));
    assertEquals("\"\"", JsString.quote(null));
  }

  @Test
  public void escapesQuotesAndBackslashes() {
    assertEquals("\"say \\\"hi\\\"\"", JsString.quote("say \"hi\""));
    assertEquals("\"back\\\\slash\"", JsString.quote("back\\slash"));
  }

  @Test
  public void escapesNewlinesWhichWouldOtherwiseEndTheLiteral() {
    assertEquals("\"a\\nb\"", JsString.quote("a\nb"));
    assertEquals("\"a\\rb\"", JsString.quote("a\rb"));
    assertEquals("\"a\\tb\"", JsString.quote("a\tb"));
  }

  @Test
  public void escapesLineSeparatorsThatJsonWouldLetThrough() {
    // U+2028/U+2029 are legal in a JSON string but terminate a JavaScript
    // string literal. A naive JSON quoter here would let a crafted player name
    // break the host engine.
    assertEquals("\"a\\u2028b\"", JsString.quote("a\u2028b"));
    assertEquals("\"a\\u2029b\"", JsString.quote("a\u2029b"));
  }

  @Test
  public void escapesControlCharacters() {
    assertEquals("\"a\\u0000b\"", JsString.quote("a\u0000b"));
    assertEquals("\"a\\u001fb\"", JsString.quote("a\u001fb"));
  }

  @Test
  public void escapesAngleBracketsSoItIsSafeInMarkupToo() {
    assertEquals("\"\\u003c/script\\u003e\"", JsString.quote("</script>"));
  }

  @Test
  public void leavesRealTextAlone() {
    // The game's own vocabulary must survive unmangled.
    String order = "Engage QUANTUM FLANGE!";
    assertEquals("\"" + order + "\"", JsString.quote(order));
    assertEquals("\"\u2604\ufe0f SHAKE!\"", JsString.quote("\u2604\ufe0f SHAKE!"));
  }
}
