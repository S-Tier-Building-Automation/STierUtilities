# Dev helper: a minimal fake BACnet/IP device for exercising the BACnet
# Explorer tab without real hardware. Binds UDP 47808, answers any Who-Is
# (broadcast or unicast) with a canned I-Am — device 1234, max-APDU 1476,
# segmentation none, vendor 999 — and rejects every confirmed request with
# unrecognized-service so the app's enrichment fallbacks return quickly.
# Runs for -Seconds (default 180), then exits.
param([int]$Seconds = 180)

$ErrorActionPreference = 'Stop'

# BVLC unicast | NPDU 01 00 | I-Am: 10 00 C4 02 00 04 D2 22 05 C4 91 03 22 03 E7
$iam = [byte[]](0x81,0x0A,0x00,0x15,0x01,0x00,0x10,0x00,0xC4,0x02,0x00,0x04,0xD2,0x22,0x05,0xC4,0x91,0x03,0x22,0x03,0xE7)

$udp = New-Object System.Net.Sockets.UdpClient
$udp.Client.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket, [Net.Sockets.SocketOptionName]::ReuseAddress, $true)
$udp.Client.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 47808))
$udp.Client.ReceiveTimeout = 1000
Write-Host "fake-bacnet: listening on UDP 47808 for $Seconds s"

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
  try { $data = $udp.Receive([ref]$ep) } catch { continue }
  if ($data.Length -lt 8 -or $data[0] -ne 0x81) { continue }

  # APDU offset: BVLC(4) + NPDU. NPDU = ver, ctrl [+ dnet(2) dlen(1) dadr(n) hop(1)].
  $apduOff = 6
  if ($data[5] -band 0x20) { $apduOff = 10 + $data[8] }
  if ($apduOff -ge $data.Length) { continue }

  $pdu = $data[$apduOff] -band 0xF0
  if ($pdu -eq 0x10) {
    [void]$udp.Send($iam, $iam.Length, $ep)
    Write-Host "fake-bacnet: Who-Is from $ep -> sent I-Am (device 1234)"
  } elseif ($pdu -eq 0x00) {
    $invoke = $data[$apduOff + 2]
    $rej = [byte[]](0x81,0x0A,0x00,0x09,0x01,0x00,0x60,$invoke,0x09)
    [void]$udp.Send($rej, $rej.Length, $ep)
  }
}
$udp.Close()
Write-Host "fake-bacnet: done"
