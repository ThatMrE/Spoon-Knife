package io.github.thatmre.spaceteamlan;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

/**
 * Runs on a plain JVM (no device, no emulator), which is why the address logic
 * lives in a class with no Android imports.
 */
public class HostAddressTest {

  @Test
  public void addsTheDefaultPortToABareAddress() {
    assertEquals("192.168.1.24:3000", HostAddress.normalise("192.168.1.24"));
    assertEquals("laptop.local:3000", HostAddress.normalise("laptop.local"));
  }

  @Test
  public void keepsAnExplicitPort() {
    assertEquals("192.168.1.24:8080", HostAddress.normalise("192.168.1.24:8080"));
  }

  @Test
  public void acceptsWhatPeopleActuallyType() {
    // The host prints a full URL, so pasting it must work.
    assertEquals("192.168.1.24:3000", HostAddress.normalise("http://192.168.1.24:3000"));
    assertEquals("192.168.1.24:3000", HostAddress.normalise("http://192.168.1.24:3000/"));
    assertEquals("10.0.0.5:3000", HostAddress.normalise("https://10.0.0.5/join?code=ABCD"));
    assertEquals("192.168.1.9:3000", HostAddress.normalise("  192.168.1.9  "));
  }

  @Test
  public void treatsNothingUsableAsEmpty() {
    assertEquals("", HostAddress.normalise(""));
    assertEquals("", HostAddress.normalise(null));
    assertEquals("", HostAddress.normalise("   "));
    assertEquals("", HostAddress.normalise("http://"));
  }

  @Test
  public void fallsBackToTheDefaultPortRatherThanFailing() {
    assertEquals(3000, HostAddress.portFrom("192.168.1.24"));
    assertEquals(8080, HostAddress.portFrom("192.168.1.24:8080"));
    assertEquals(3000, HostAddress.portFrom("192.168.1.24:99999"));
    assertEquals(3000, HostAddress.portFrom("192.168.1.24:0"));
    assertEquals(3000, HostAddress.portFrom("192.168.1.24:abc"));
    assertEquals(3000, HostAddress.portFrom("192.168.1.24:"));
  }

  @Test
  public void splitsTheHostOffTheAddress() {
    assertEquals("192.168.1.24", HostAddress.hostFrom("http://192.168.1.24:8080/x"));
    assertEquals("192.168.1.24", HostAddress.hostFrom("192.168.1.24"));
  }

  @Test
  public void sweepsTheSubnetWithoutWastingProbes() {
    List<String> hosts = HostAddress.hostsInSubnet(new byte[] {(byte) 192, (byte) 168, 1, 24});

    assertEquals(253, hosts.size());
    assertFalse("never probe ourselves", hosts.contains("192.168.1.24"));
    assertFalse("no network address", hosts.contains("192.168.1.0"));
    assertFalse("no broadcast address", hosts.contains("192.168.1.255"));
    assertTrue(hosts.contains("192.168.1.1"));
    assertTrue(hosts.contains("192.168.1.254"));
  }

  @Test
  public void treatsOctetsAsUnsigned() {
    // 172 and 200 are negative as signed bytes; getting this wrong would
    // produce addresses like "-84.16.-56.2".
    List<String> hosts = HostAddress.hostsInSubnet(new byte[] {(byte) 172, 16, (byte) 200, 1});
    assertEquals("172.16.200.2", hosts.get(0));
    assertTrue(hosts.contains("172.16.200.254"));
  }

  @Test
  public void returnsNothingForNonsenseInput() {
    assertTrue(HostAddress.hostsInSubnet(null).isEmpty());
    assertTrue(HostAddress.hostsInSubnet(new byte[] {1, 2, 3}).isEmpty());
  }

  @Test
  public void recognisesAddressesThatOnlyWorkOnThisPhone() {
    // Hosting connects the host's own client to loopback; that address must not
    // be remembered as somewhere to join next time.
    assertTrue(HostAddress.isLoopback("127.0.0.1:3000"));
    assertTrue(HostAddress.isLoopback("127.0.0.1"));
    assertTrue(HostAddress.isLoopback("localhost:3000"));
    assertTrue(HostAddress.isLoopback("http://127.0.0.1:3000/"));
    assertFalse(HostAddress.isLoopback("192.168.1.24:3000"));
    assertFalse(HostAddress.isLoopback("10.0.0.5"));
  }
}
