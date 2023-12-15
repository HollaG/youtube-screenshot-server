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

    // console.log(info.formats.filter(f => f.qualityLabel === ""));
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
                    console.log("Stream started");
                });

                videoStream.on("error", (e) => {
                    console.log(e.name);
                    console.log({ e });
                });

                videoStream.on("progress", (chunkLength, downloaded, total) => {
                    const percent = downloaded / total;

                    console.log(percent);
                });

                videoStream.pipe(fs.createWriteStream(pathToVideo));

                videoStream.on("finish", () => {
                    resolve(null);
                    console.log("Finished piping");

                    videoStream.destroy();
                });
            };

            start();
        });
    }

    await downloadVideo(url);

    /**
    const videoStream = ytdl(url, { quality: 136 });







    
    videoStream.once("response", () => {
        startTime = Date.now();
        console.log("Stream started");
    });
    videoStream.on("progress", (chunkLength, downloaded, total) => {
        const percent = downloaded / total;
        const downloaded_minutes = (Date.now() - startTime) / 1000 / 60;
        const estimated_download_time =
            downloaded_minutes / percent - downloaded_minutes;

        console.log(estimated_download_time);
        // if the estimated download time is more than 1.5 minutes then we cancel and restart the download, this value works fine for me but you may need to change it based on your server/internet speed.
        if (Number(estimated_download_time.toFixed(2)) >= 1.5) {
            console.warn(
                "Seems like YouTube is limiting our download speed, restarting the download to mitigate the problem.."
            );
            //   stream.destroy();
            //   start();
        }
    });

    videoStream.on("error", console.log);

    videoStream.pipe(fs.createWriteStream(pathToVideo));

    function waitForStreamPiped() {
        return new Promise((resolve, reject) => {
            videoStream.on("finish", () => {
                resolve(null);
                console.log("Finished piping");
            });
        });
    }

    await waitForStreamPiped();
    */

    // get the screenshots
    // const screenshotProcess = ffmpeg(pathToVideo)
    //     .on("error", (err) => console.log(err))
    //     .on("filenames", function (filenames) {
    //         console.log("Will generate " + filenames.join(", "));
    //     })
    //     .screenshots({
    //         timestamps: timestamps,
    //         filename: "thumbnail-%s.png",
    //         folder: pathToFolder,
    //         // size: "320x240",
    //     });

    let i = 0;
    let screenshotProcess: ffmpeg.FfmpegCommand;
    function takeScreenshots(pathToVideo: string) {
        console.log("Running takeScreenshots");
        return new Promise((resolve, reject) => {
            ffmpeg(pathToVideo)
                .on("start", () => {
                    if (i < 1) {
                        console.log(`start taking screenshots`);
                    }
                })
                .on("end", () => {
                    i = i + 1;
                    console.log(`taken screenshot: ${i}`);

                    if (i < timestamps.length) {
                        takeScreenshots(pathToVideo).then(() => resolve(null));
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

    await takeScreenshots(pathToVideo);

    console.log("Completed take screenshots");

    /**
     * Helper function to convert the 'finished screenshot' event to async
     *
     */
    // function waitForScreenshots() {
    //     return new Promise((resolve, reject) => {
    //         screenshotProcess.on("end", () => {
    //             console.log(i, timestamps.length);
    //             if (i === timestamps.length) {
    //                 console.log(null, "Screenshots taken");
    //                 resolve(null);
    //             }
    //         });
    //     });
    // }

    // await waitForScreenshots();

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
                : 0
        );

        const thisLeft = Math.round(
            cropSettings[timestamp] ? cropSettings[timestamp].left : leftDefault
        );

        console.log({
            thisImageHeight,
            thisImageWidth,
            thisLeft,
            thisTopOffset,
        });
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
        headless: "new",
    });
    const page = await browser.newPage();
    await page.goto(
        `${process.env.HOSTNAME}/screenshots/${videoId}/result.html`
    );

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
