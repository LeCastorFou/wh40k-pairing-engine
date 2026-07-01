# Force Disposition Terrain Images

Terrain map images are stored here with their original uploaded names.

The app automatically looks for three images per force disposition matchup:

```text
{Your-Force}_vs_{Opponent-Force}_Layout-A.png
{Your-Force}_vs_{Opponent-Force}_Layout-B.png
{Your-Force}_vs_{Opponent-Force}_Layout-C.png
```

Supported extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`.

Examples:

```text
Take-and-Hold_vs_Reconnaissance_Layout-A.png
Take-and-Hold_vs_Reconnaissance_Layout-B.png
Take-and-Hold_vs_Reconnaissance_Layout-C.png
Priority-Assets_vs_Disruption_Layout-A.webp
```

The app first checks the exact ordered matchup name, then also checks the reverse order. For example, `Reconnaissance_vs_Take-and-Hold_Layout-A.png` can still be used by a Take and hold vs Recon matchup if the exact `Take-and-Hold_vs_Reconnaissance_Layout-A.png` file is not present.

Valid file labels:

```text
Priority-Assets
Reconnaissance
Take-and-Hold
Purge-the-Foe
Disruption
```

If an image is not present yet, the Fight page shows a placeholder card for that map.
