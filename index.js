const puppeteer = require('puppeteer');
const R = require("ramda");
const dateAdd = require('date-fns/add');
require('dotenv').config();
const mailjet = require('node-mailjet').connect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET);

const SLOT_TYPE = {
    FIXED_1HR: 1,
    FLEXI_SAVER: 4
};

const SLOTS_PAGE = "https://www.tesco.com/groceries/en-GB/slots/delivery";
const NOTIFICATION_SOURCE = "murphybob@gmail.com";
const NOTIFICATION_TARGET = "murphybob@gmail.com";

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
        },);
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
                        "Name": "SlotBot"
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
    let slotsUnvailable = [];
    const offsets = R.map(R.multiply(7), R.range(0, 3));
    for (const offset of offsets) {
        const date = dateAdd(new Date(), {days: offset});
        console.log("Querying slots for", date);
        const slots = await getSlotsData(page, date, SLOT_TYPE.FIXED_1HR, csrf);
        const [available, unavailable] = R.partition(isAvailable, slots);
        console.log("Found", slots.length, "slots");
        console.log("Available", available.length);
        console.log("Unavailable", unavailable.length);
        slotsAvailable = slotsAvailable.concat(available);
        slotsUnvailable = slotsUnvailable.concat(unavailable);
    }

    if (slotsAvailable.length > 0) {
        console.log("Slots available, sending email notification");
        await sendEmail(
            NOTIFICATION_TARGET,
            "SlotBot: Slots Available!",
            "The following slots were available\n\n" + slotsAvailable.map(formatSlotTime).join("\n"));
    }
    else {
        console.log("No slots available, sending email notification");
        await sendEmail(
            NOTIFICATION_TARGET,
            "SlotBot: No slots",
            "The following slots were unavailable\n\n" + slotsUnvailable.map(formatSlotTime).join("\n"));

    }

    console.log("Closing");
    await browser.close();
})();