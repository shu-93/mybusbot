
const { google } = require("googleapis");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const LTA_API = "https://datamall2.mytransport.sg/ltaodataservice";
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let sheetsPromise;

async function getSheets() {
  if (!sheetsPromise) {
    sheetsPromise = auth.getClient().then((client) =>
      google.sheets({ version: "v4", auth: client })
    );
  }
  return sheetsPromise;
}

async function sheetRead(range) {
  const sheets = await getSheets();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return result.data.values || [];
}

async function sheetAppend(range, values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

async function sheetUpdate(range, values) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function telegram(method, body) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function answerCallback(callbackId) {
  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
    });
  } catch (error) {
    console.error("Callback response failed");
  }
}

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: "My favourite stops" }],
      [{ text: "Add a favourite" }],
      [{ text: "Manage favourites" }],
    ],
    resize_keyboard: true,
  };
}

async function showMenu(chatId) {
  await sendMessage(
    chatId,
    "Choose a bus stop to see the next arrivals for all your saved services.",
    { reply_markup: menuKeyboard() }
  );

  await showFavourites(chatId, "arrivals");
}

async function getFavourites() {
  const rows = await sheetRead("'Favourites'!A2:D");
  return rows
    .map((row, index) => ({
      rowNumber: index + 2,
      stopCode: String(row[0] || "").trim(),
      stopName: String(row[1] || "").trim(),
      serviceNo: String(row[2] || "").trim(),
      label: String(row[3] || "").trim(),
    }))
    .filter((item) => item.stopCode && item.serviceNo);
}

async function getFavourite(rowNumber) {
  const rows = await sheetRead(
    `'Favourites'!A${rowNumber}:D${rowNumber}`
  );
  const row = rows[0];
  if (!row || !row[0] || !row[2]) return null;

  return {
    rowNumber,
    stopCode: String(row[0]).trim(),
    stopName: String(row[1] || "").trim(),
    serviceNo: String(row[2]).trim(),
    label: String(row[3] || "").trim(),
  };
}

async function getState(chatId) {
  const rows = await sheetRead("'UserState'!A2:E");
  const index = rows.findIndex(
    (row) => String(row[0] || "") === String(chatId)
  );

  if (index < 0) return null;

  const row = rows[index];
  return {
    rowNumber: index + 2,
    chatId: String(row[0]),
    step: String(row[1] || ""),
    stopCode: String(row[2] || ""),
    stopName: String(row[3] || ""),
    serviceNo: String(row[4] || ""),
  };
}

async function setState(chatId, step, stopCode = "", stopName = "", serviceNo = "") {
  const existing = await getState(chatId);
  const values = [[String(chatId), step, stopCode, stopName, serviceNo]];

  if (existing) {
    await sheetUpdate(
      `'UserState'!A${existing.rowNumber}:E${existing.rowNumber}`,
      values
    );
  } else {
    await sheetAppend("'UserState'!A:E", values);
  }
}

async function clearState(chatId) {
  await setState(chatId, "", "", "", "");
}

async function ltaRequest(path) {
  const response = await fetch(`${LTA_API}${path}`, {
    headers: {
      AccountKey: process.env.LTA_API_KEY,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`LTA request failed with status ${response.status}`);
  }

  return response.json();
}

async function findBusStop(stopCode) {
  const query = new URLSearchParams({
    "$filter": `BusStopCode eq '${stopCode}'`,
  });

  const data = await ltaRequest(`/BusStops?${query.toString()}`);
  const stop = (data.value || []).find(
    (item) => String(item.BusStopCode) === stopCode
  );

  if (!stop) return null;

  return {
    stopCode: String(stop.BusStopCode),
    stopName: String(stop.Description),
  };
}

async function getBusArrival(stopCode, serviceNo) {
  const query = new URLSearchParams({
    BusStopCode: stopCode,
    ServiceNo: serviceNo,
  });

  const data = await ltaRequest(`/v3/BusArrival?${query.toString()}`);

  return (data.Services || []).find(
    (item) => String(item.ServiceNo) === serviceNo
  ) || null;
}

function formatArrival(estimatedArrival) {
  if (!estimatedArrival) return null;

  const arrivalTime = new Date(estimatedArrival);
  if (Number.isNaN(arrivalTime.getTime())) return null;

  const minutes = Math.ceil((arrivalTime.getTime() - Date.now()) / 60000);

  if (minutes <= 1) return "Arriving";
  return `${minutes} min`;
}

function getNextThree(service) {
  if (!service) return [];

  return [
    service.NextBus,
    service.NextBus2,
    service.NextBus3,
  ]
    .map((bus) => formatArrival(bus && bus.EstimatedArrival))
    .filter(Boolean);
}


async function showFavourites(chatId, mode = "arrivals") {
  const favourites = await getFavourites();

  if (!favourites.length) {
    await sendMessage(
      chatId,
      "You haven't saved any favourites yet. Tap Add a favourite to get started.",
      { reply_markup: menuKeyboard() }
    );
    return;
  }

  if (mode === "arrivals") {
    const stops = new Map();

    for (const item of favourites) {
      if (!stops.has(item.stopCode)) {
        stops.set(item.stopCode, {
          stopCode: item.stopCode,
          stopName: item.stopName,
        });
      }
    }

    const buttons = Array.from(stops.values()).map((stop) => ({
      text: `${stop.stopName} (${stop.stopCode})`,
      callback_data: `s:${stop.stopCode}`,
    }));

    await sendMessage(
      chatId,
      "Choose a bus stop to compare all your saved bus services there.",
      {
        reply_markup: {
          inline_keyboard: buttons.map((button) => [button]),
        },
      }
    );
    return;
  }

  const buttons = favourites.map((item) => [
    {
      text: `View ${item.serviceNo} · ${item.stopCode}`,
      callback_data: `f:${item.rowNumber}`,
    },
    {
      text: `Remove ${item.serviceNo} · ${item.stopCode}`,
      callback_data: `r:${item.rowNumber}`,
    },
  ]);

  await sendMessage(
    chatId,
    "Your saved favourites. Choose one to view arrivals or remove it.",
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}


async function showStopArrivals(chatId, stopCode) {
  const favourites = (await getFavourites()).filter(
    (item) => item.stopCode === stopCode
  );

  if (!favourites.length) {
    await sendMessage(chatId, "No saved bus services were found for this stop.");
    return;
  }

  const stopName = favourites[0].stopName || "Bus stop";
  const results = await Promise.all(
    favourites.map(async (item) => {
      try {
        const service = await getBusArrival(
          item.stopCode,
          item.serviceNo
        );

        if (!service) {
          return {
            serviceNo: item.serviceNo,
            times: ["No arrival data available"],
          };
        }

        const times = getNextThree(service);

        return {
          serviceNo: item.serviceNo,
          times: times.length
            ? times
            : ["No arrival estimates available"],
        };
      } catch (error) {
        console.error(
          `Arrival lookup failed for service ${item.serviceNo}:`,
          error.message
        );

        return {
          serviceNo: item.serviceNo,
          times: ["Unable to retrieve arrivals"],
        };
      }
    })
  );

  const sections = results.map((result) =>
    `Service ${result.serviceNo}\n${result.times.join(" · ")}`
  );

  const message =
    `${stopName} (${stopCode})\n\n` +
    sections.join("\n\n");

  await sendMessage(chatId, message, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Refresh arrivals",
            callback_data: `s:${stopCode}`,
          },
          {
            text: "Back to stops",
            callback_data: "next",
          },
        ],
      ],
    },
  });
}

async function removeFavourite(chatId, rowNumber) {
  const favourite = await getFavourite(rowNumber);

  if (!favourite) {
    await sendMessage(chatId, "That favourite could not be found.");
    return;
  }

  await sheetUpdate(
    `'Favourites'!A${rowNumber}:D${rowNumber}`,
    [["", "", "", ""]]
  );

  await sendMessage(
    chatId,
    `Removed Service ${favourite.serviceNo} at ${favourite.stopName} (${favourite.stopCode}).`,
    { reply_markup: menuKeyboard() }
  );
}

async function startAdding(chatId) {
  await setState(chatId, "await_stop_code");
  await sendMessage(
    chatId,
    "Enter the 5-digit bus stop code. You can find it on the bus stop sign or in LTA's bus stop information."
  );
}

async function handleText(chatId, text) {
  const message = text.trim();

  if (message === "/start" || message === "/menu") {
    await clearState(chatId);
    await showMenu(chatId);
    return;
  }

  if (message === "Add a favourite") {
    await startAdding(chatId);
    return;
  }

  if (message === "My favourite stops") {
    await showFavourites(chatId, "arrivals");
    return;
  }

  if (message === "Manage favourites") {
    await showFavourites(chatId, "manage");
    return;
  }

  const state = await getState(chatId);

  if (!state || !state.step) {
    await sendMessage(
      chatId,
      "Please choose an option from the menu.",
      { reply_markup: menuKeyboard() }
    );
    return;
  }

  if (state.step === "await_stop_code") {
    if (!/^\d{5}$/.test(message)) {
      await sendMessage(chatId, "Please enter a valid 5-digit bus stop code.");
      return;
    }

    const stop = await findBusStop(message);

    if (!stop) {
      await sendMessage(
        chatId,
        "I couldn't find that stop code in LTA's bus stop data. Check the code and try again."
      );
      return;
    }

    await setState(
      chatId,
      "await_service_no",
      stop.stopCode,
      stop.stopName
    );

    await sendMessage(
      chatId,
      `Bus stop found:\n${stop.stopName} (${stop.stopCode})\n\nNow enter the bus service number, for example 851.`
    );
    return;
  }

  if (state.step === "await_service_no") {
    if (!/^\d{1,3}[A-Za-z]?$/.test(message)) {
      await sendMessage(
        chatId,
        "Please enter a bus service number, such as 7, 851 or 36A."
      );
      return;
    }

    const serviceNo = message.toUpperCase();
    const service = await getBusArrival(state.stopCode, serviceNo);

    if (!service) {
      await sendMessage(
        chatId,
        `LTA didn't return Service ${serviceNo} for ${state.stopName} (${state.stopCode}). Check the service number and try again.`
      );
      return;
    }

    await sheetAppend("'Favourites'!A:D", [[
      state.stopCode,
      state.stopName,
      serviceNo,
      "",
    ]]);

    await clearState(chatId);

    await sendMessage(
      chatId,
      `Favourite saved:\n${state.stopName} (${state.stopCode})\nService ${serviceNo}`,
      { reply_markup: menuKeyboard() }
    );
  }
}

async function handleCallback(callback) {
  const chatId = callback.message && callback.message.chat.id;
  if (!chatId) return;

  const data = callback.data || "";

  const stopMatch = data.match(/^s:(\d+)$/);

  if (stopMatch) {
    await showStopArrivals(chatId, stopMatch[1]);
    return;
  }

  if (data === "next") {
    await showFavourites(chatId, "arrivals");
    return;
  }

  if (data === "manage") {
    await showFavourites(chatId, "manage");
    return;
  }

  if (data === "add") {
    await startAdding(chatId);
    return;
  }

  const match = data.match(/^([fr]):(\d+)$/);

  if (match) {
    const action = match[1];
    const rowNumber = Number(match[2]);

    if (action === "f") {
      const favourite = await getFavourite(rowNumber);

      if (!favourite) {
        await sendMessage(chatId, "That favourite could not be found.");
        return;
      }

      await showArrivals(chatId, favourite);
      return;
    }

    if (action === "r") {
      await removeFavourite(chatId, rowNumber);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).send("My Bus Bot endpoint is running.");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed.");
  }

  try {
    const update = req.body;

    if (update.callback_query) {
      await answerCallback(update.callback_query.id);
      await handleCallback(update.callback_query);
    } else if (update.message && update.message.text) {
      await handleText(
        update.message.chat.id,
        update.message.text
      );
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Bot request failed:", error.message);

    const chatId =
      req.body &&
      req.body.message &&
      req.body.message.chat &&
      req.body.message.chat.id;

    if (chatId) {
      try {
        await sendMessage(
          chatId,
          "Something went wrong while processing that request. Please try again shortly."
        );
      } catch (sendError) {
        console.error("Could not send error message");
      }
    }

    return res.status(200).send("OK");
  }
};
