# Setting up your chart camera

The chart camera is a small computer (a Raspberry Pi) that sits next to the
internet box at home. During market hours it keeps your TradingView chart
open on its own screen (an invisible one: no monitor needed) and records it.
When Schwab fills your order, it keeps the picture from that exact second,
one every 5 minutes while you are in the trade, one at the exact second you
sell, and a video of the trade. They show up in your journal by themselves.

You set it up **once**. It takes about an hour. You need the MacBook for it.

---

## What you need

- The parts on the shopping list: the Raspberry Pi 5 (8 GB), the Active
  Cooler, the 27W power supply, the SSD kit, the bumper or case, a microSD
  card, a network cable and a USB-C card reader.
- The MacBook, on the same home internet as the Pi.
- Your journal's **App Key** (the box on the Journal tab of your app).
- Your TradingView username and password.

---

## Step 1: Put the Pi together

1. Stick the **Active Cooler** onto the Pi (its leaflet shows how; it clips
   into two holes and its little cable plugs into the socket marked FAN).
2. Fit the **SSD kit** on top, following its leaflet (it comes with taller
   pins so it sits above the cooler, and a short flat ribbon cable).
3. Put the Pi on its **bumper** (or in its case).
4. Do not plug it in yet.

## Step 2: Prepare the memory card (on the MacBook)

1. On the MacBook, download **Raspberry Pi Imager** from
   raspberrypi.com/software and open it.
2. Put the microSD card in the card reader, and the reader in the MacBook.
3. In Imager, choose:
   - Device: **Raspberry Pi 5**
   - Operating system: **Raspberry Pi OS (other)**, then
     **Raspberry Pi OS Lite (64-bit)**
   - Storage: the memory card.
4. When it asks about settings, choose **Edit settings** and set:
   - Hostname: **chartcam**
   - Username and password: choose your own and **write them down**.
   - Leave wireless (Wi-Fi) **off**: the Pi uses the cable.
   - On the **Services** tab, turn on **SSH** with password.
5. Write the card. When it says it is finished, take it out.

## Step 3: Plug it in

1. Put the memory card into the Pi (the slot underneath).
2. Plug the **network cable** from the Pi into a socket on the back of the
   T-Mobile box.
3. Plug in the **power supply**. Wait 3 minutes for it to start the first
   time.

## Step 4: Connect to it from the MacBook

1. On the MacBook, open **Terminal** (press Command + Space, type
   Terminal, press Return).
2. Type this and press Return (use the username you chose):

       ssh yourusername@chartcam.local

3. If it asks "Are you sure you want to continue connecting", type `yes`.
4. Type your Pi password (nothing shows as you type; that is normal).

You are now typing on the Pi. Everything below is typed in this window.

## Step 5: Download and install the camera

Copy each line, paste it into Terminal, press Return, and wait for it to
finish before the next:

    sudo apt-get install -y git
    git clone -b claude/chart-camera https://github.com/alynnyree/strat-journal-backend.git
    cd strat-journal-backend
    bash chart-camera/setup/install.sh --format-ssd

The last line takes several minutes. It installs what the camera needs and
prepares the SSD. **It only prepares a brand-new, blank SSD.** If it says
"not blank", stop and tell Claude.

## Step 6: Fill in your details

    nano /etc/chart-camera/config.json

A text editor opens. Change three things (use the arrow keys to move):

- `appKey`: replace `PUT-YOUR-APP-KEY-HERE` with your journal's App Key.
  It is typed here, on your own Pi, and nowhere else.
- `chartUrl`: open TradingView in a browser on the MacBook, open the chart
  layout you trade from, and copy the address from the address bar (it looks
  like `https://www.tradingview.com/chart/AbCd1234/`). Paste it in place of
  the example.
- `defaultSymbol`: the symbol to show when no trade is open (`SPY` or `IWM`).
  Pick the one you trade most: a trade on the symbol already showing gets
  its entry picture from the exact second.

Save: press **Control + O**, then **Return**, then **Control + X**.

## Step 7: Sign in to TradingView on the camera (once)

The camera needs to be signed in to your TradingView account so it shows
your layout and your drawn lines.

1. Set a password for the remote view (type one when asked, twice):

       x11vnc -storepasswd

2. Start the camera and its remote view:

       sudo systemctl start chart-camera
       sudo systemctl start chart-camera-vnc

3. On the MacBook, open **Finder**, choose **Go** in the top menu, then
   **Connect to Server**, type `vnc://chartcam.local` and press Connect.
   Enter the remote-view password.
4. You see the camera's screen with TradingView. Sign in to your account.
   Your chart layout appears.
5. Close the remote view window, then switch the remote view off:

       sudo systemctl stop chart-camera-vnc

## Step 8: A practice trade

    node chart-camera/src/practice.js SPY

This runs a pretend trade (marked as practice the whole way, so it never
lands on a real trade). Leave it about 10 minutes. It says what arrived:

    ARRIVED: the entry picture
    ARRIVED: the during picture
    ARRIVED: the exit picture
    ARRIVED: the recording
    Practice finished: 4 of 4 arrived. Everything works.

If anything says **NOT SENT**, copy those lines to Claude.

You can now unplug the MacBook. The camera starts by itself whenever the Pi
has power, records during market hours (9:25 a.m. to 4:20 p.m. New York
time, weekdays) and checks for a newer version of itself every morning.

---

## Checking on it later

From the MacBook, connect as in Step 4, then:

    node strat-journal-backend/chart-camera/src/status.js

It says, in plain words, whether it is recording, what the chart shows,
how much room is left, and anything that went wrong.

## Good to know

- **Use the TradingView app on your phone** while you trade. The camera is
  signed in as "a web browser"; a second web browser signed in at the same
  time (a laptop, Safari on your phone) may be logged out.
- **If the internet drops**, the camera keeps recording and holds the
  pictures. They arrive, with their correct times, once it is back.
- **If TradingView signs the camera out**, the camera says so. Repeat Step 7.
- **Videos** need the free video storage switched on in your service (a
  Cloudflare account). Until then, pictures still work, and a full-quality
  copy of every trade is kept on the camera's own drive.
