// Parses the development applications at the South Australian Berri Barmera Council web site
// and places them in a database.
//
// Michael Bone
// 4th December 2018

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as moment from "moment";
import * as didyoumean from "didyoumean2";
import * as urlparser from "url";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "http://www.berribarmera.sa.gov.au/page.aspx?u=375";
const CommentUrl = "mailto:bbc@bbc.sa.gov.au";

declare const process: any;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if the row does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications in the specified date range.

async function parsePdf(pdfUrl, database) {
    console.log(`Reading development applications from ${pdfUrl}.`);

    // await insertRow(database, {
    //     applicationNumber: applicationNumber,
    //     address: address,
    //     description: description,
    //     informationUrl: developmentApplicationUrl,
    //     commentUrl: CommentUrl,
    //     scrapeDate: moment().format("YYYY-MM-DD"),
    //     receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
    // });
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the main page of development applications.

    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
//    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    let pdfUrls: string[] = [];
    for (let element of $("div.u6ListItem a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if (!pdfUrls.some(url => url === pdfUrl))
            pdfUrls.push(pdfUrl);
    }

    for (let pdfUrl of pdfUrls)
        console.log(pdfUrl);

    // Obtain the PDF URLs from the previous years pages.

    let yearUrls: string[] = [];
    for (let element of $("div.unityHtmlArticle h4 a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if (!yearUrls.some(url => url === pdfUrl))
            yearUrls.push(pdfUrl);
    }

    for (let yearUrl of yearUrls) {
        body = await request({ url: yearUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
//        await sleep(2000 + getRandom(0, 5) * 1000);
        $ = cheerio.load(body);

        let elements = []
            .concat($("td.uContentListDesc p a").get())
            .concat($("td.u6ListTD div.u6ListItem a").get())
            .concat($("div.unityHtmlArticle p a").get());

        for (let element of elements) {
            let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
            if (!pdfUrls.some(url => url === pdfUrl))
                pdfUrls.push(pdfUrl);
        }
    }

    console.log("----------");
    for (let pdfUrl of pdfUrls)
        console.log(pdfUrl);

    // Parse a PDF file.

    // await parsePdf(pdfUrl, database);
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
