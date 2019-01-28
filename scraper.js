// Parses the development applications at the South Australian Berri Barmera Council web site
// and places them in a database.
//
// Michael Bone
// 4th December 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const didyoumean2_1 = require("didyoumean2"), didyoumean = didyoumean2_1;
sqlite3.verbose();
const DevelopmentApplicationsUrl = "http://www.berribarmera.sa.gov.au/page.aspx?u=375";
const CommentUrl = "mailto:bbc@bbc.sa.gov.au";
// All valid street and suburb names.
let SuburbNames = null;
let StreetNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if the row does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).
function getRowTop(elements, startElement) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y) // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50) // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Calculates the square of the Euclidean distance between two elements.
function calculateDistance(element1, element2) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20% (ie. ignore elements that overlap too much in the horizontal direction)
        return Number.MAX_VALUE;
    return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
}
// Determines whether there is vertical overlap between two elements.
function isVerticalOverlap(element1, element2) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}
// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).
function getVerticalOverlapPercentage(element1, element2) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}
// Gets the element immediately to the right of the specified element (but ignores elements that
// appear after a large horizontal gap).
function getRightElement(elements, element) {
    let closestElement = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 && // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) && // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) && // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement)) // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Finds the element that most closely matches the specified text.
function findElement(elements, text, shouldSelectRightmostElement) {
    // Examine all the elements on the page that being with the same character as the requested
    // text.
    let condensedText = text.replace(/[\s,\-_]/g, "").toLowerCase();
    let firstCharacter = condensedText.charAt(0);
    let matches = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith(firstCharacter))) {
        // Extract up to 5 elements to the right of the element that has text starting with the
        // required character (and so may be the start of the requested text).  Join together the
        // elements to the right in an attempt to find the best match to the text.
        let rightElement = element;
        let rightElements = [];
        do {
            rightElements.push(rightElement);
            let currentText = rightElements.map(element => element.text).join("").replace(/[\s,\-_]/g, "").toLowerCase();
            if (currentText.length > text.length + 2) // stop once the text is too long
                break;
            if (currentText.length >= text.length - 2) { // ignore until the text is close to long enough
                if (currentText === condensedText)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 0, text: currentText });
                else if (didyoumean2_1.default(currentText, [condensedText], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true }) !== null)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 1, text: currentText });
                else if (didyoumean2_1.default(currentText, [condensedText], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true }) !== null)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 2, text: currentText });
            }
            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 5); // up to 5 elements
    }
    // Chose the best match (if any matches were found).
    if (matches.length > 0) {
        let bestMatch = matches.reduce((previous, current) => (previous === undefined ||
            previous.threshold < current.threshold ||
            (previous.threshold === current.threshold && Math.abs(previous.text.length - condensedText.length) <= Math.abs(current.text.length - condensedText.length)) ? current : previous), undefined);
        return shouldSelectRightmostElement ? bestMatch.rightElement : bestMatch.leftElement;
    }
    return undefined;
}
// Finds the start element of each development application on the current PDF page (there are
// typically two development applications on a single page and each development application
// typically begins with the text "Application No").
function findStartElements(elements) {
    // Examine all the elements on the page that being with "A" or "a".
    let startElements = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("a"))) {
        // Extract up to 5 elements to the right of the element that has text starting with the
        // letter "a" (and so may be the start of the "Application No" text).  Join together the
        // elements to the right in an attempt to find the best match to the text "Application No".
        let rightElement = element;
        let rightElements = [];
        let matches = [];
        do {
            rightElements.push(rightElement);
            // Allow for common misspellings of the "no." text.
            let text = rightElements.map(element => element.text).join("").replace(/[\s,\-_]/g, "").replace(/n0/g, "no").replace(/n°/g, "no").replace(/"o/g, "no").replace(/"0/g, "no").replace(/"°/g, "no").replace(/“°/g, "no").toLowerCase();
            if (text.length >= 16) // stop once the text is too long
                break;
            if (text.length >= 13) { // ignore until the text is close to long enough
                if (text === "applicationno")
                    matches.push({ element: rightElement, threshold: 0, text: text });
                else if (didyoumean2_1.default(text, ["ApplicationNo"], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1, text: text });
                else if (didyoumean2_1.default(text, ["ApplicationNo"], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2, text: text });
            }
            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 5); // up to 5 elements
        // Chose the best match (if any matches were found).
        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) => (previous === undefined ||
                previous.threshold < current.threshold ||
                (previous.threshold === current.threshold && Math.abs(previous.text.length - "ApplicationNo".length) <= Math.abs(current.text.length - "ApplicationNo".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }
    // Ensure the start elements are sorted in the order that they appear on the page.
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
}
// Gets the text to the right in a rectangle, where the rectangle is delineated by the positions
// in which the three specified strings of (case sensitive) text are found.
function getRightText(elements, topLeftText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topLeftElement = findElement(elements, topLeftText, true);
    let rightElement = (rightText === undefined) ? undefined : findElement(elements, rightText, false);
    let bottomElement = (bottomText === undefined) ? undefined : findElement(elements, bottomText, false);
    if (topLeftElement === undefined)
        return undefined;
    let x = topLeftElement.x + topLeftElement.width;
    let y = topLeftElement.y;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    if (intersectingElements.length === 0)
        return undefined;
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Gets the text downwards in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.
function getDownText(elements, topText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topElement = findElement(elements, topText, true);
    let rightElement = (rightText === undefined) ? undefined : findElement(elements, rightText, false);
    let bottomElement = (bottomText === undefined) ? undefined : findElement(elements, bottomText, false);
    if (topElement === undefined)
        return undefined;
    let x = topElement.x;
    let y = topElement.y + topElement.height;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    if (intersectingElements.length === 0)
        return undefined;
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Parses the details from the elements associated with a single development application.
function parseApplicationElements(elements, startElement, informationUrl) {
    // Get the application number.
    let applicationNumber = getRightText(elements, "Application No", "Application Date", "Applicants Name");
    if (applicationNumber === undefined || applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    applicationNumber = applicationNumber.replace(/[Il,]/g, "/");
    console.log(`    Found \"${applicationNumber}\".`);
    // Get the received date.
    let receivedDateText = "";
    if (elements.some(element => element.text.trim() == "Application Received")) {
        receivedDateText = getRightText(elements, "Application Received", "Planning Approval", "Land Division Approval");
        if (receivedDateText === undefined)
            receivedDateText = getRightText(elements, "Application Date", "Planning Approval", "Application Received");
    }
    else if (elements.some(element => element.text.trim() == "Application received")) {
        receivedDateText = getRightText(elements, "Application received", "Planning Approval", "Building Application");
        if (receivedDateText === undefined)
            receivedDateText = getRightText(elements, "Application Date", "Planning Approval", "Application received");
    }
    let receivedDate = undefined;
    if (receivedDateText !== undefined)
        receivedDate = moment(receivedDateText.trim(), "D/MM/YYYY", true);
    // Get the house number, street and suburb of the address.
    let houseNumber = getRightText(elements, "Property House No", "Planning Conditions", "Lot");
    if (houseNumber === undefined || houseNumber === "0")
        houseNumber = "";
    let streetName = getRightText(elements, "Property Street", "Planning Conditions", "Property Suburb");
    if (streetName === undefined || streetName === "" || streetName === "0") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found or parsed (there is no street name).  Elements: ${elementSummary}`);
        return undefined;
    }
    let suburbName = getRightText(elements, "Property Suburb", "Planning Conditions", "Title");
    if (suburbName === undefined || suburbName === "" || suburbName === "0") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found or parsed (there is no suburb name for street \"${streetName}\").  Elements: ${elementSummary}`);
        return undefined;
    }
    // Two addresses are sometimes recorded in the same field.  This is done in a way which is
    // ambiguous (ie. it is not possible to reconstruct the original addresses perfectly).
    //
    // For example, the following address:
    //
    //     House Number: ü35
    //           Street: RAILWAYüSCHOOL TCE SOUTHüTERRA
    //           Suburb: PASKEVILLEüPASKEVILLE
    //
    // should be interpreted as the following two addresses:
    //
    //     RAILWAY TCE SOUTH, PASKEVILLE
    //     35 SCHOOL TERRA(CE), PASKEVILLE
    //
    // whereas the following address:
    //
    //     House Number: 79ü4
    //           Street: ROSSLYNüSWIFT WINGS ROADüROAD
    //           Suburb: WALLAROOüWALLAROO
    //
    // should be interpreted as the following two addresses:
    //
    //     79 ROSSLYN ROAD, WALLAROO
    //     4 SWIFT WINGS ROAD, WALLAROO
    //
    // And so notice that in the first case above the "TCE" text of the Street belonged to the
    // first address.  Whereas in the second case above the "WINGS" text of the Street belonged
    // to the second address (this was deduced by examining actual existing street names).
    let address = "";
    if (houseNumber.includes("ü")) {
        // The house number always has at most one "ü" character.  So split on this character.
        let houseNumber1 = houseNumber.split("ü")[0];
        let houseNumber2 = houseNumber.split("ü")[1];
        // The street name may have one or two "ü" characters.
        let streetName1 = undefined;
        let streetName2 = undefined;
        let streetNameTokens = streetName.split("ü");
        if (streetNameTokens.length === 2) {
            // If there is one "ü" character in the street then simply split on this to determine
            // the street names.  For example, "SMITH STREETüRAILWAY TERRACE" is simply split into
            // "SMITH STREET" and "RAILWAY TERRACE".
            streetName1 = streetNameTokens[0];
            streetName2 = streetNameTokens[1];
        }
        else if (streetNameTokens.length === 3) {
            // If there are two "ü" characters then the splitting is more complicated if the
            // middle token contains more than one space.
            let streetName1Prefix = streetNameTokens[0];
            let streetName2Suffix = streetNameTokens[2];
            streetNameTokens = streetNameTokens[1].split(" ");
            if (streetNameTokens.length === 2) {
                // This is a simple case because the middle token contains only one space.  For
                // example, "OLIVEüTUCKER PARADEüROAD" becomes "OLIVE PARADE" and "TUCKER ROAD".
                streetName1 = streetName1Prefix + " " + streetNameTokens[1];
                streetName2 = streetNameTokens[0] + " " + streetName2Suffix;
            }
            else if (streetNameTokens.length === 3) {
                // This is a more complicated case because the middle token contains two spaces.
                // For example, in "ROSSLYNüSWIFT WINGS ROADüSTREET" does "WINGS" belong with the
                // first street or the second?  Either "ROSSLYN WINGS ROAD"/"SWIFT STREET" would
                // result or "ROSSLYN ROAD"/"SWIFT WINGS STREET" would result.  Determining which
                // is the reason for the "didyoumean" calls.
                streetName1 = streetName1Prefix + " " + streetNameTokens[1] + " " + streetNameTokens[2];
                streetName2 = streetNameTokens[0] + " " + streetName2Suffix;
                let streetNameMatch1 = didyoumean2_1.default(streetName1, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
                let streetNameMatch2 = didyoumean2_1.default(streetName2, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
                if (streetNameMatch1 === null && streetNameMatch2 === null) {
                    streetName1 = streetName1Prefix + " " + streetNameTokens[2];
                    streetName2 = streetNameTokens[0] + " " + streetNameTokens[1] + " " + streetName2Suffix;
                }
            }
        }
        // Remove the "hundred" prefix that appears in some addresses.
        let suburbName1 = suburbName.split("ü")[0].replace(/^HD /, "");
        let suburbName2 = suburbName.split("ü")[1].replace(/^HD /, "");
        // There are typically two addresses (for example, delineating a corner block).  Prefer
        // the address that has a house number.
        if (/[0-9]+[a-zA-Z]?/.test(houseNumber1))
            address = houseNumber1 + " " + streetName1 + ", " + (SuburbNames[suburbName1.toUpperCase()] || suburbName1);
        else if (/[0-9]+[a-zA-Z]?/.test(houseNumber2))
            address = houseNumber2 + " " + streetName2 + ", " + (SuburbNames[suburbName2.toUpperCase()] || suburbName2);
        else
            address = houseNumber1 + " " + streetName1 + ", " + (SuburbNames[suburbName1.toUpperCase()] || suburbName1);
    }
    else {
        suburbName = suburbName.replace(/^HD /, "");
        address = `${houseNumber} ${streetName}, ${SuburbNames[suburbName.toUpperCase()] || suburbName}`;
    }
    address = address.trim().replace(/\s\s+/g, " ");
    // Get the description.
    let description = getDownText(elements, "Development Description", "Relevant Authority", "Private Certifier Name");
    // Construct the resulting application information.
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description === "") ? "No Description Provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    };
}
// Parses the development applications in the specified date range.
async function parsePdf(url) {
    console.log(`Reading development applications from ${url}.`);
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop appears
    // not to be enough to release all memory used by the PDF parsing).
    for (let pageIndex = 0; pageIndex < 500; pageIndex++) { // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: workaroundHeight };
        });
        // Release the memory used by the PDF now that it is no longer required (it will be
        // re-parsed on the next iteration of the loop for the next page).
        await pdf.destroy();
        if (global.gc)
            global.gc();
        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);
        // Group the elements into sections based on where the "Application No" text starts.
        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height) because
            // in some cases the lodged date might be higher up than the "Application No" text.
            let startElement = startElements[index];
            let raisedStartElement = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - startElement.height / 2,
                width: startElement.width,
                height: startElement.height
            };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;
            // Extract all elements between the two rows.
            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }
        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time in the same document then this likely indicates the parsing has incorrectly
        // recognised some of the digits in the application number.  In this case add a suffix to
        // the application number so it is unique (and so will be inserted into the database later
        // instead of being ignored).
        for (let applicationElementGroup of applicationElementGroups) {
            let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, url);
            if (developmentApplication !== undefined) {
                let suffix = 0;
                let applicationNumber = developmentApplication.applicationNumber;
                while (developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber))
                    developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`; // add a unique suffix
                developmentApplications.push(developmentApplication);
            }
        }
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read the files containing all possible street and suburb names.
    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName); // several suburbs may exist for the same street name
    }
    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].trim()] = suburbTokens[1].trim();
    }
    // Read the main page of development applications.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    let pdfUrls = [];
    for (let element of $("div.u6ListItem a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (!pdfUrls.some(url => url === pdfUrl))
            pdfUrls.push(pdfUrl);
    }
    // Obtain the PDF URLs from the previous years' pages.
    let yearUrls = [];
    for (let element of $("div.unityHtmlArticle h4 a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (!yearUrls.some(url => url === pdfUrl))
            yearUrls.push(pdfUrl);
    }
    for (let yearUrl of yearUrls) {
        body = await request({ url: yearUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
        await sleep(2000 + getRandom(0, 5) * 1000);
        $ = cheerio.load(body);
        let elements = []
            .concat($("td.uContentListDesc p a").get())
            .concat($("td.u6ListTD div.u6ListItem a").get())
            .concat($("div.unityHtmlArticle p a").get());
        for (let element of elements) {
            let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
            if (!pdfUrls.some(url => url === pdfUrl))
                pdfUrls.push(pdfUrl);
        }
    }
    // Always parse the most recent PDF file and randomly select one other PDF file to parse.
    if (pdfUrls.length === 0) {
        console.log("No PDF files were found on the page.");
        return;
    }
    console.log(`Found ${pdfUrls.length} PDF file(s).  Selecting two to parse.`);
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();
    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).
        if (global.gc)
            global.gc();
        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNkZBQTZGO0FBQzdGLGlDQUFpQztBQUNqQyxFQUFFO0FBQ0YsZUFBZTtBQUNmLG9CQUFvQjtBQUVwQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBQ3BDLHlFQUFzRDtBQUV0RCxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFFbEIsTUFBTSwwQkFBMEIsR0FBRyxtREFBbUQsQ0FBQztBQUN2RixNQUFNLFVBQVUsR0FBRywwQkFBMEIsQ0FBQztBQUk5QyxxQ0FBcUM7QUFFckMsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3ZCLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUV2Qiw4QkFBOEI7QUFFOUIsS0FBSyxVQUFVLGtCQUFrQjtJQUM3QixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ25DLElBQUksUUFBUSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNuRCxRQUFRLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRTtZQUNwQixRQUFRLENBQUMsR0FBRyxDQUFDLDhMQUE4TCxDQUFDLENBQUM7WUFDN00sT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3RCLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDO0FBRUQsbUVBQW1FO0FBRW5FLEtBQUssVUFBVSxTQUFTLENBQUMsUUFBUSxFQUFFLHNCQUFzQjtJQUNyRCxPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ25DLElBQUksWUFBWSxHQUFHLFFBQVEs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QU0sS0FBSyxDQUFDLEVBQUU7UUFDdEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQ0FBc0MsQ0FBQyxDQUFDO1FBQ3BELE9BQU87S0FDVjtJQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsU0FBUyxPQUFPLENBQUMsTUFBTSx3Q0FBd0MsQ0FBQyxDQUFDO0lBRTdFLDRGQUE0RjtJQUM1Riw4RkFBOEY7SUFDOUYsWUFBWTtJQUVaLElBQUksZUFBZSxHQUFhLEVBQUUsQ0FBQztJQUNuQyxlQUFlLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ3RDLElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDO1FBQ2xCLGVBQWUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNoRSxJQUFJLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQztRQUNyQixlQUFlLENBQUMsT0FBTyxFQUFFLENBQUM7SUFFOUIsS0FBSyxJQUFJLE1BQU0sSUFBSSxlQUFlLEVBQUU7UUFDaEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUMzQyxJQUFJLHVCQUF1QixHQUFHLE1BQU0sUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3JELE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSx1QkFBdUIsQ0FBQyxNQUFNLDhDQUE4QyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBRTVHLG1GQUFtRjtRQUNuRixpREFBaUQ7UUFFakQsSUFBSSxNQUFNLENBQUMsRUFBRTtZQUNULE1BQU0sQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUVoQixPQUFPLENBQUMsR0FBRyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDckUsS0FBSyxJQUFJLHNCQUFzQixJQUFJLHVCQUF1QjtZQUN0RCxNQUFNLFNBQVMsQ0FBQyxRQUFRLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztLQUN6RDtBQUNMLENBQUM7QUFFRCxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyJ9