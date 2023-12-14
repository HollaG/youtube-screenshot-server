import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";
import ffmpeg from "fluent-ffmpeg";
import ytdl from "ytdl-core";
import fs from "fs-extra";
import sharp from "sharp";
import PDFDocument, { image } from "pdfkit";
import puppeteer from "puppeteer";
import { CropSettings } from "./types";
dotenv.config();

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req: Request, res: Response) => {
    res.send("Express + TypeSdcript Server");
    // res.write
});

app.post("/", async (req: Request, res: Response) => {
    console.log(req.body);

    const url = req.body.url as string;
    const timestamps = req.body.timestamps as number[];
    const cropSettings = req.body.cropSettings as CropSettings;

    // get the video ID
    const videoId = ytdl.getURLVideoID(url);

    // get the video name
    const videoTitle = (await ytdl.getBasicInfo(url)).videoDetails.title;

    // create a new folder and ensure it's empty
    const pathToFolder = "./public/screenshots/" + videoId;
    await fs.emptyDir(pathToFolder);

    const videoStream = ytdl(url, { quality: "highestvideo" });
    const pathToVideo = pathToFolder + "/video/" + "video.mp4";

    await fs.ensureDir(pathToFolder + "/video/");
    videoStream.pipe(fs.createWriteStream(pathToVideo));

    /**
     * Helper function to convert the `end` event to asynchronous
     * Avoids nested code
     *
     */
    function waitForStreamPiped() {
        return new Promise((resolve, reject) => {
            videoStream.on("end", resolve);
        });
    }

    await waitForStreamPiped();

    // get the screenshots
    const screenshotProcess = ffmpeg(pathToVideo)
        .on("error", (err) => console.log(err))
        .on("filenames", function (filenames) {
            console.log("Will generate " + filenames.join(", "));
        })
        .screenshots({
            timestamps: timestamps,
            filename: "thumbnail-%s.png",
            folder: pathToFolder,
            // size: "320x240",
        });

    /**
     * Helper function to convert the 'finished screenshot' event to async
     *
     */
    function waitForScreenshots() {
        return new Promise((resolve, reject) => {
            screenshotProcess.on("end", () => {
                console.log(null, "Screenshots taken");
                resolve(null);
            });
        });
    }

    await waitForScreenshots();

    // get the filenames of all images and sort them according to the timestamp.
    const imageNames = (await fs.readdir(pathToFolder)).filter(
        (f) => f !== "video"
    );

    console.log({ imageNames });
    // necessary step if not it will be sorted by ascii
    imageNames.sort((a: string, b: string) => {
        // file format: thumbnail-%s.png
        const aTimeStr = a.split("-")[1].replace(".png", "");
        const bTimeStr = b.split("-")[1].replace(".png", "");

        const aTime = Number(aTimeStr);
        const bTime = Number(bTimeStr);

        return aTime - bTime;
    });

    const imageHeight = 1080;
    const imageWidth = 1920;
    const leftDefault = 0;
    let imagePaths = [];

    for (const imageName of imageNames) {
        console.log(imageName);
        const newImagePath = pathToFolder + "/" + "cropped-" + imageName;

        // get the crop
        const timestamp = Number(imageName.split("-")[1].replace(".png", ""));
        const thisImageHeight = Math.round(
            cropSettings[timestamp]
                ? imageHeight -
                      ((100 - cropSettings[timestamp].bottomOffset) / 100) *
                          imageHeight -
                      (cropSettings[timestamp].bottom / 100) * imageHeight
                : imageHeight
        );

        const thisImageWidth = Math.round(
            cropSettings[timestamp]
                ? imageWidth -
                      (cropSettings[timestamp].left / 100) * imageWidth -
                      ((100 - cropSettings[timestamp].leftOffset) / 100) *
                          imageWidth
                : imageWidth
        );

        const thisTopOffset = Math.round(
            cropSettings[timestamp]
                ? ((100 - cropSettings[timestamp].bottomOffset) / 100) *
                      imageHeight
                : imageHeight
        );

        const thisLeft = Math.round(
            cropSettings[timestamp] ? cropSettings[timestamp].left : leftDefault
        );

        await sharp(pathToFolder + "/" + imageName)
            .extract({
                width: thisImageWidth,
                height: thisImageHeight,
                left: thisLeft,
                top: thisTopOffset,
            })
            .toFile(newImagePath);

        imagePaths.push(newImagePath);
    }

    // generate HTML
    const html = generateHtml(imageNames, videoTitle);

    fs.writeFile(pathToFolder + "/result.html", html);
    // generate pdf from html
    const browser = await puppeteer.launch({
        headless: true,
    });
    const page = await browser.newPage();
    await page.goto(`http://localhost:3000/screenshots/${videoId}/result.html`);

    await page.emulateMediaType("screen");

    const pdfPath = pathToFolder + "/result.pdf";
    const pdf = await page.pdf({
        path: pdfPath,
        margin: { top: "100px", right: "50px", bottom: "100px", left: "50px" },
        printBackground: true,
        format: "A4",
    });

    console.log("---------- DONE -----------");
    res.download(pdfPath, (err) => {
        // clear the folder
        fs.rm(pathToFolder, { recursive: true, force: true });
    });

    // res.json({
    //     success: true,
    //     body: req.body,
    // });
});

/**
 * Gets basic information about the video.
 */
app.get("/info", async (req: Request, res: Response) => {
    const url = req.query.url as string;
    console.log(url);

    if (!url) {
        // reject
        res.status(400).json({
            error: true,
            message: "No video URL provided!",
        });

        return;
    }

    // validate the url

    if (!ytdl.validateURL(url)) {
        // reject
        res.status(400).json({
            error: true,
            message: "Invalid URL format!",
        });

        return;
    }

    const basicInfo = (await ytdl.getBasicInfo(url)).videoDetails;

    console.log(basicInfo);
    return res.json({
        success: true,
        data: basicInfo,
    });
});

app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
});

function generateHtml(imageNames: string[], videoTitle: string) {
    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>${videoTitle}}</title>
    </head>
    <body>
        <h1 style="text-align: center"> ${videoTitle} </h1> 
        <div style="display: flex; flex-direction: column; justify-content: center">
            ${imageNames
                .map((imageName) => `<img src="cropped-${imageName}"/>`)
                .join(" ")}
        </div>
    </body>
    
    </html>

    `;

    return html;
}
