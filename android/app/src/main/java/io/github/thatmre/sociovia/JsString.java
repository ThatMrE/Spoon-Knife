package io.github.thatmre.sociovia;

/**
 * Quotes a string so it can be interpolated into JavaScript source.
 *
 * The host pushes each decoded client frame into the engine with
 * {@code WebView.evaluateJavascript}, so text that arrived over the network is
 * spliced into JS source. Player names come from whatever someone typed into
 * their phone, which makes this a correctness boundary rather than a nicety.
 *
 * Note U+2028 and U+2029: both are legal inside a JSON string but terminate a
 * JavaScript string literal, so a naive JSON quoter would let a crafted player
 * name break the host engine. They are escaped here.
 */
public final class JsString {

  private JsString() {}

  /** {@code text} as a double-quoted JavaScript string literal. */
  public static String quote(String text) {
    if (text == null) return "\"\"";

    StringBuilder out = new StringBuilder(text.length() + 16);
    out.append('"');
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        case '\b':
          out.append("\\b");
          break;
        case '\f':
          out.append("\\f");
          break;
        case '<':
        case '>':
          // Cheap insurance against "</script>" if this ever lands in markup.
          // Escaping both is symmetric and leaves nothing to reason about.
          out.append(c == '<' ? "\\u003c" : "\\u003e");
          break;
        case ' ':
          out.append("\\u2028");
          break;
        case ' ':
          out.append("\\u2029");
          break;
        default:
          if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
      }
    }
    out.append('"');
    return out.toString();
  }
}
