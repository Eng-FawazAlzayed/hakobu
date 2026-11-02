# Credits

## JDownloader 2

Hakobu's file host handling includes logic ported to JavaScript from JDownloader 2 by AppWork GmbH and the JDownloader
contributors (JD-Team). The ported files are licensed under the GNU General Public License, version 3 or later, and so is
Hakobu. JDownloader is a trademark of its owners. Hakobu is an independent project and isn't affiliated with or endorsed
by them.

- Project: https://jdownloader.org/
- Official source: svn://svn.jdownloader.org/jdownloader/trunk
- Used through: https://github.com/mycodedoesnotcompile2/jdownloader_mirror, commit
  6ab1aecdfce4be3896cfd0948f97d86cf66286be (2026-11-02), a daily mirror of that repository

| Hakobu file | JDownloader source (under `svn_trunk/src`) | Revision |
|---|---|---|
| `src/engine/hosts/xfs.js` | `org/jdownloader/plugins/components/XFileSharingProBasic.java` | 53786 |
| | `jd/plugins/hoster/DatanodesTo.java` | 53121 |
| | `jd/plugins/hoster/SendNow.java` | 52974 |
| | `jd/plugins/hoster/DdownloadCom.java` | 53187 |
| | `jd/plugins/hoster/KatfileCom.java` | 53743 |
| | `jd/plugins/hoster/HexloadCom.java` | 52647 |
| | `jd/plugins/hoster/ClicknuploadOrg.java` | 52239 |
| | `jd/plugins/hoster/UsersdriveCom.java` | 46225 |
| | `jd/plugins/hoster/DailyuploadsNet.java` | 53165 |
| | `jd/plugins/hoster/FilespayoutCom.java` | 50684 |
| `src/engine/hosts/simple.js` | `jd/plugins/hoster/KrakenfilesCom.java` | 52214 |
| | `jd/plugins/hoster/FuckingfastCo.java` | 53129 |
| | `jd/plugins/hoster/UploadhavenCom.java` | 52786 |
| | `jd/plugins/hoster/VikingfileCom.java` | 51437 |
| `src/engine/hosts/buzzheavier.js` | `jd/plugins/hoster/BuzzheavierCom.java` | 52799 |
| `src/engine/hosts/onefichier.js` | `jd/plugins/hoster/OneFichierCom.java` | 53703 |
| `src/engine/hosts/mediafire.js` | `jd/plugins/hoster/MediafireCom.java` | 53182 |
| `src/engine/hosts/gdrive.js` | `jd/plugins/hoster/GoogleDrive.java` | 53450 |

The logic was rewritten in JavaScript and changed to fit Hakobu. In particular, captchas go to a window where the person
solves them, and code that works around bot checks was not ported. Only GPL source files were used, not the closed parts
of JDownloader's official builds.
