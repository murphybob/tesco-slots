const puppeteer = require('puppeteer');
const R = require("ramda");
const dateAdd = require('date-fns/add');
require('dotenv').config();
const { IncomingWebhook } = require('@slack/webhook');
const mailjet = require('node-mailjet').connect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET);

const SLOT_TYPE = {
    FIXED_1HR: 1,
    FLEXI_SAVER: 4
};

const LOCATION_ID = {
    HISTON_HOME: 2065,
    NOTTINGHAM: 5379
}

const LOOK_AHEAD_WEEKS = 4

const APP_NAME = "SlotBot"
const SLOTS_PAGE = "https://www.tesco.com/groceries/en-GB/slots/delivery";
const NOTIFICATION_SOURCE = "murphybob@gmail.com";
const NOTIFICATION_TARGET = process.env.NOTIFICATION_TARGET;

const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);

async function getSlotsData(page, date, type, csrf) {
    const url = `${SLOTS_PAGE}/${date.toISOString().slice(0, 10)}?slotGroup=${type}`;
    const json = await page.evaluate(async (url, csrf) => {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-csrf-token": csrf
            }
        });
        return await response.json();
    }, url, csrf);
    return json.slots;
}

function isAvailable(slot) {
    const status = slot.status.toLowerCase();
    return status !== "unavailable" && status !== "booked";
}

async function sendEmail(to, subject, text, html = "") {
    const request = await mailjet
        .post("send", {"version": "v3.1"})
        .request({
            "Messages": [
                {
                    "From": {
                        "Email": NOTIFICATION_SOURCE,
                        "Name": APP_NAME
                    },
                    "To": [
                        {
                            "Email": to,
                            "Name": "Robert"
                        }
                    ],
                    "Subject": subject,
                    "TextPart": text,
                    "HTMLPart": html || text.replace(/\n/g, "<br>"),
                    "CustomID": "AppGettingStartedTest"
                }
            ]
        });
}

const dateTimeFormatter = Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "numeric"
});

function formatSlotTime(slot) {
    return dateTimeFormatter.format(new Date(Date.parse(slot.start)));
}

(async () => {
    console.log("Initializing");
    const browser = await puppeteer.launch({args: ["--no-sandbox"]});
    const page = await browser.newPage();

    console.log("Logging in");
    await page.goto("https://secure.tesco.com/account/en-GB/login");
    await page.type("#username", process.env.USERNAME);
    await page.type("#password", process.env.PASSWORD);
    await page.click("#sign-in-form .ui-component__button");

    console.log("Entering slots page");
    await page.goto(SLOTS_PAGE);
    const csrf = await page.$eval("[name=_csrf]", el => el.value);

    let slotsAvailable = [];
    const offsets = R.map(R.multiply(7), R.range(0, LOOK_AHEAD_WEEKS));
    for (const offset of offsets) {
        const date = dateAdd(new Date(), {days: offset});
        console.log("Querying slots for", date);
        const slots = await getSlotsData(page, date, SLOT_TYPE.FIXED_1HR, csrf);
        const [available, unavailable] = R.partition(isAvailable, slots);
        console.log("Found", slots.length, "slots");
        console.log("Available", available.length);
        console.log("Unavailable", unavailable.length);
        slotsAvailable = slotsAvailable.concat(available);
    }

    if (slotsAvailable.length > 0) {
        console.log("Slots available, sending email notification");
        const message = "" +
            "The following slots were available\n\n" +
            slotsAvailable.map(formatSlotTime).join("\n") +
            "\n\nhttps://www.tesco.com/groceries/en-GB/slots/delivery/";
        const emailRequest = sendEmail(
            NOTIFICATION_TARGET,
            `${APP_NAME}: Slots Available!`,
            message
        );
        const slackRequest = webhook.send({
            username: APP_NAME,
            icon_emoji: ":slot_machine:",
            text: message
        })
        await Promise.all([emailRequest, slackRequest])
    }

    console.log("Closing");
    await browser.close();
})();
