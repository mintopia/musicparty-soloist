-- Headless container: no Bluetooth, no seat. The bluez monitor pulls in the
-- systemd-logind plugin, which fails fatally (exit 70) without a real logind —
-- taking WirePlumber down with it. We only route the virtual soloist-sink, so
-- disable bluez entirely. Loaded before 90-enable-all runs bluez_monitor.enable().
bluez_monitor.enabled = false
