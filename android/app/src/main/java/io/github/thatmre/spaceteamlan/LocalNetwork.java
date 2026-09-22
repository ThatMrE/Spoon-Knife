package io.github.thatmre.spaceteamlan;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

/**
 * Finding this device on its own WiFi. Plain JDK, no Android imports, so the
 * parts that can be reasoned about are testable and the parts that depend on
 * the machine's interfaces are isolated here.
 */
public final class LocalNetwork {

  private LocalNetwork() {}

  /** This device's private IPv4 address, or null if it is not on a LAN. */
  public static InetAddress privateIPv4() {
    try {
      Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
      while (interfaces != null && interfaces.hasMoreElements()) {
        NetworkInterface nif = interfaces.nextElement();
        if (!nif.isUp() || nif.isLoopback()) continue;

        for (InterfaceAddress entry : nif.getInterfaceAddresses()) {
          InetAddress address = entry.getAddress();
          if (address instanceof Inet4Address && address.isSiteLocalAddress()) return address;
        }
      }
    } catch (Exception ignored) {
      // No network, or an interface we cannot inspect.
    }
    return null;
  }

  /** "192.168.1.24", or null when offline. */
  public static String privateIPv4Text() {
    InetAddress address = privateIPv4();
    return address == null ? null : address.getHostAddress();
  }

  /** Every other usable address in this device's /24, for the discovery sweep. */
  public static List<String> subnetCandidates() {
    InetAddress address = privateIPv4();
    if (address == null) return new ArrayList<String>();
    return HostAddress.hostsInSubnet(address.getAddress());
  }
}
