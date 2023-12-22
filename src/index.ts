import express, { Express, Request, Response, response } from "express";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";
import ffmpeg from "fluent-ffmpeg";
import ytdl from "ytdl-core";
import fs from "fs-extra";
import sharp from "sharp";
import PDFDocument, { image, path } from "pdfkit";
import puppeteer from "puppeteer";
import { CropSettings } from "./types";
import JSZip from "jszip";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const limiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // daily
    limit: 10, // Limit each IP to 100 requests per `window` (here, per 15 minutes).
    standardHeaders: "draft-7", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
    // store: ... , // Use an external store for consistency across multiple server instances.
    message: async (req: Request, res: Response) => {
        return "You have hit your 10 downloads for today! Please try again in 24 hours.";
    },
    handler: (req, res, next, options) => {
        res.status(options.statusCode).json({
            message: options.message,
        });
    },

    // the following two use a "hack" - we need an API endpoint to check how many requests we have left
    // we designate GET / as the endpoint, and thus we mark any request to GET / as failed
    // According to the docs, returning false from `requestWasSuccessful` will deduct 1 from the quota, and then
    // add it back. Hence, we have to modify the rateLimit returned in GET /.
    // see: https://express-rate-limit.mintlify.app/reference/configuration#skipfailedrequests
    skipFailedRequests: true,
    requestWasSuccessful: (req, res) =>
        !(req.url === "/" && req.method === "GET") && res.statusCode < 400,
});

app.get("/", limiter, async (req: Request, res: Response) => {
    // @ts-expect-error
    console.log(req.rateLimit);
    res.json({
        // @ts-expect-error
        remaining: req.rateLimit.remaining + 1,

        // @ts-expect-error
        resetTime: req.rateLimit.resetTime,
    });
});

const ENABLE_LOGGING = true;
const VERBOSE = false;

const INFO_LEVEL = 2;
const VERBOSE_LEVEL = 3;

const LOG_LEVEL = 2;

app.post("/", limiter, async (req: Request, res: Response) => {
    try {
        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(req.body);

        const url = req.body.url as string;
        const timestamps = req.body.timestamps as number[];

        if (!timestamps || timestamps.length === 0 || timestamps[0] === null) {
            return res.status(400).json({
                message: "Invalid or missing timestamps!",
            });
        }

        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log({ timestamps });
        const cropSettings = req.body.cropSettings as CropSettings;

        if (LOG_LEVEL >= INFO_LEVEL)
            console.info(`INFO: Recieved new video ${url}`);

        // get the video ID
        const videoId = ytdl.getURLVideoID(url);

        // get the video name
        const videoTitle = (await ytdl.getBasicInfo(url)).videoDetails.title;

        // create a new folder and ensure it's empty
        const pathToFolder = "./public/screenshots/" + videoId;
        await fs.emptyDir(pathToFolder);

        // if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(info.formats.filter(f => f.qualityLabel === ""));
        await fs.ensureDir(pathToFolder + "/video/");

        const pathToVideo = pathToFolder + "/video/" + "video.mp4";

        let ERROR_COUNT = 0;
        function downloadVideo(url: string) {
            return new Promise((resolve, reject) => {
                let startTime: number;
                const start = () => {
                    const videoStream = ytdl(url, { quality: 136 });
                    videoStream.once("response", () => {
                        startTime = Date.now();
                        if (LOG_LEVEL >= VERBOSE_LEVEL)
                            console.log("Stream started");
                    });

                    videoStream.on("error", (e) => {
                        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(e.name);
                        //@ts-expect-error
                        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(e.code!);

                        // @ts-expect-error
                        if (e.code === "ETIMEDOUT") {
                            // try again
                            videoStream.destroy();
                            if (LOG_LEVEL >= INFO_LEVEL)
                                console.error(
                                    "ERROR: Connection refused. Trying again"
                                );
                            start();
                        } else {
                            console.error(e);
                        }
                    });

                    videoStream.on(
                        "progress",
                        (chunkLength, downloaded, total) => {
                            const percent = downloaded / total;

                            if (LOG_LEVEL >= INFO_LEVEL) console.info(percent);
                        }
                    );

                    videoStream.pipe(fs.createWriteStream(pathToVideo));

                    videoStream.on("finish", () => {
                        resolve(null);
                        if (LOG_LEVEL >= INFO_LEVEL)
                            console.info("INFO: Finished downloading video");

                        videoStream.destroy();
                    });
                };

                start();
            });
        }

        if (LOG_LEVEL >= INFO_LEVEL) console.info("INFO: Downloading video");
        await downloadVideo(url);

        let i = 0;
        function takeScreenshots(pathToVideo: string) {
            if (LOG_LEVEL >= VERBOSE_LEVEL)
                console.log("Running takeScreenshots");
            return new Promise((resolve, reject) => {
                ffmpeg(pathToVideo)
                    .on("start", () => {
                        if (i < 1) {
                            if (LOG_LEVEL >= VERBOSE_LEVEL)
                                console.log(`start taking screenshots`);
                        }
                    })
                    .on("end", () => {
                        i = i + 1;
                        if (LOG_LEVEL >= VERBOSE_LEVEL)
                            console.log(`taken screenshot: ${i}`);

                        if (i < timestamps.length) {
                            takeScreenshots(pathToVideo).then(() =>
                                resolve(null)
                            );
                        } else {
                            // end
                            resolve(null);
                        }
                    })
                    .screenshots({
                        count: 1,
                        timemarks: [timestamps[i]],
                        filename: "thumbnail-%s.png",
                        folder: pathToFolder,
                    });
            });
        }

        if (LOG_LEVEL >= INFO_LEVEL) console.info("INFO: Taking screenshots");
        await takeScreenshots(pathToVideo);

        if (LOG_LEVEL >= INFO_LEVEL)
            console.info("INFO: Finished taking screenshots");

        // get the filenames of all images and sort them according to the timestamp.
        const imageNames = (await fs.readdir(pathToFolder)).filter(
            (f) => f !== "video"
        );

        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log({ imageNames });
        // necessary step if not it will be sorted by ascii
        imageNames.sort((a: string, b: string) => {
            // file format: thumbnail-%s.png
            const aTimeStr = a.split("-")[1].replace(".png", "");
            const bTimeStr = b.split("-")[1].replace(".png", "");

            const aTime = Number(aTimeStr);
            const bTime = Number(bTimeStr);

            return aTime - bTime;
        });

        function getMetadata(): Promise<ffmpeg.FfprobeData> {
            return new Promise((resolve, reject) => {
                ffmpeg.ffprobe(pathToVideo, function (err, metadata) {
                    if (err) {
                        reject(err);
                    } else {
                        // metadata should contain 'width', 'height' and 'display_aspect_ratio'
                        resolve(metadata);
                    }
                });
            });
        }

        const { streams } = await getMetadata();
        // streams[0] contains the video metadata.
        // streams[1] contains the audio metadata, but in this case our video file doesn't have audio metadata.

        const imageHeight = streams[0].height || streams[0].coded_height || 720;
        const imageWidth = streams[0].width || streams[0].coded_width || 1280;
        const leftDefault = 0;

        let totalHeight = 0;

        if (LOG_LEVEL >= INFO_LEVEL) console.info("INFO: Cropping images");

        const zip = new JSZip();
        for (const imageName of imageNames) {
            if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(imageName);
            const newImagePath = pathToFolder + "/" + "cropped-" + imageName;

            // get the crop
            const timestamp = Number(
                imageName.split("-")[1].replace(".png", "")
            );
            const thisImageHeight = Math.round(
                cropSettings[timestamp]
                    ? imageHeight -
                          ((100 - cropSettings[timestamp].bottomOffset) / 100) *
                              imageHeight -
                          (cropSettings[timestamp].bottom / 100) * imageHeight
                    : imageHeight
            );

            totalHeight = totalHeight + thisImageHeight;

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
                    : 0
            );

            const thisLeft = Math.round(
                cropSettings[timestamp]
                    ? cropSettings[timestamp].left
                    : leftDefault
            );

            if (LOG_LEVEL >= VERBOSE_LEVEL)
                console.log({
                    thisImageHeight,
                    thisImageWidth,
                    thisLeft,
                    thisTopOffset,
                });

            const sharpData = sharp(pathToFolder + "/" + imageName).extract({
                width: thisImageWidth,
                height: thisImageHeight,
                left: thisLeft,
                top: thisTopOffset,
            });

            const blob = await sharpData.toBuffer();
            await sharpData.toFile(newImagePath);

            zip.file(`${timestamp}.png`, blob);
        }

        if (LOG_LEVEL >= INFO_LEVEL)
            console.info("INFO: Finished cropping images");

        if (LOG_LEVEL >= INFO_LEVEL) console.info("INFO: Generating HTML");
        // generate HTML
        const html = generateHtml(imageNames, videoTitle);

        fs.writeFile(pathToFolder + "/result.html", html);
        // generate pdf from html
        const browser = await puppeteer.launch({
            headless: "new",
            protocolTimeout: 300_000, // 5 minutes
        });
        const page = await browser.newPage();
        await page.goto(
            `${process.env.HOSTNAME}/screenshots/${videoId}/result.html`
        );

        await page.emulateMediaType("screen");

        const pdfPath = pathToFolder + "/result.pdf";

        // calculate the px height (which is # of images * max of thisImageHeight + 100)
        if (LOG_LEVEL >= VERBOSE_LEVEL) console.log({ totalHeight });

        let height = await page.evaluate(
            () => document.documentElement.offsetHeight
        );

        const pdfLong = await page.pdf({
            path: pdfPath,
            margin: {
                bottom: 0,
                top: 0,
                left: 0,
                right: 0,
            },
            printBackground: true,
            height: `${height + 250}px`, // add 250 to account for page vertical margins
        });

        if (LOG_LEVEL >= INFO_LEVEL)
            console.info("INFO: Finished downloading PDF");
        // zip the files
        zip.file("result_single_page.pdf", pdfLong);
        // zip.file("result.pdf", pdf);

        const content = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: {
                level: 9,
            },
        });

        await fs.writeFile(
            `${pathToFolder}/result.zip`,
            Buffer.from(await content.arrayBuffer())
        );

        if (LOG_LEVEL >= INFO_LEVEL) console.info("INFO: Zipped files");

        if (LOG_LEVEL >= INFO_LEVEL) console.log("INFO: Completed process");
        res.download(`${pathToFolder}/result.zip`, (err) => {});
    } catch (e: any) {
        res.status(400).json({
            error: true,
            message: e.toString(),
        });
    }
});

/**
 * Gets basic information about the video.
 */
app.get("/info", async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(url);

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

    if (LOG_LEVEL >= VERBOSE_LEVEL) console.log(basicInfo);
    return res.json({
        success: true,
        data: basicInfo,
    });
});

app.listen(port, () => {
    if (LOG_LEVEL >= VERBOSE_LEVEL)
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
