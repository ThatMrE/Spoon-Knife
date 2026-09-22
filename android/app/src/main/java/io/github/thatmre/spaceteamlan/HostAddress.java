package io.github.thatmre.spaceteamlan;

import java.util.ArrayList;
import java.util.List;

/**
 * Address parsing and subnet arithmetic, deliberately free of any Android
 * import so it can be compiled and unit-tested on a plain JVM. The fiddly
 * bits of this app live here for exactly that reason.
 */
public final class HostAddress {

  public static final int DEFAULT_PORT = 3000;

  private HostAddress() {}

  /**
   * Normalise whatever a person typed into "host:port".
   * Accepts "1.2.3.4", "1.2.3.4:3000", "http://1.2.3.4:3000/" and stray spaces.
   */
  public static String normalise(String input) {
    if (input == null) return "";
    String text = input.trim();
    if (text.isEmpty()) return "";

    text = text.replaceFirst("^[a-zA-Z][a-zA-Z0-9+.-]*://", "");
    // Drop any path, query or fragment: only the authority matters.
    int cut = indexOfAny(text, "/?#");
    if (cut >= 0) text = text.substring(0, cut);
    if (text.isEmpty()) return "";

    if (text.indexOf(':') < 0) text = text + ":" + DEFAULT_PORT;
    return text;
  }

  /** The port from a typed address, falling back to the default. */
  public static int portFrom(String input) {
    String address = normalise(input);
    int colon = address.lastIndexOf(':');
    if (colon < 0 || colon == address.length() - 1) return DEFAULT_PORT;
    try {
      int port = Integer.parseInt(address.substring(colon + 1));
      return (port > 0 && port < 65536) ? port : DEFAULT_PORT;
    } catch (NumberFormatException e) {
      return DEFAULT_PORT;
    }
  }

  /** The host part of a typed address, without the port. */
  public static String hostFrom(String input) {
    String address = normalise(input);
    int colon = address.lastIndexOf(':');
    return colon < 0 ? address : address.substring(0, colon);
  }

  /**
   * Every other usable address in the /24 containing {@code octets}.
   *
   * Only /24 is swept: a /16 would be 65k probes, and home networks are /24
   * in practice. The device's own address and the network/broadcast addresses
   * are left out.
   */
  public static List<String> hostsInSubnet(byte[] octets) {
    List<String> out = new ArrayList<String>();
    if (octets == null || octets.length != 4) return out;

    int self = octets[3] & 0xff;
    String prefix = (octets[0] & 0xff) + "." + (octets[1] & 0xff) + "." + (octets[2] & 0xff) + ".";
    for (int host = 1; host <= 254; host++) {
      if (host != self) out.add(prefix + host);
    }
    return out;
  }

  private static int indexOfAny(String text, String chars) {
    for (int i = 0; i < text.length(); i++) {
      if (chars.indexOf(text.charAt(i)) >= 0) return i;
    }
    return -1;
  }
}
