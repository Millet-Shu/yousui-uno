背景音乐文件放在这里，设置面板的「曲目」下拉就能选到。

当前曲目表（public/game.js 里的 BGM.TRACKS）：
  synth  内置 · 轻音乐（合成，不需要文件）
  wind   The Wind Sings（纯音乐）  ->  music/the-wind-sings.mp3

要换歌或加歌：
  1) 把 mp3 放到这个目录；
  2) 在 game.js 的 BGM.TRACKS 里加一行 { id, name, src: 'music/文件名.mp3' }。

文件缺失时会自动退回内置合成曲，并在设置面板提示，不会静默没声音。
