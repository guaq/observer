// -*- indent-tabs-mode: nil; -*-
import React from 'react'
import LRU from 'lru-cache'

import stringify from 'json-stable-stringify'

import {ImageCanvas} from 'ol/source'
import {Image} from 'ol/layer'
import {Map as OlMap, View} from 'ol'
import {OSM} from 'ol/source'
import {Tile} from 'ol/layer'
import {fromLonLat, toLonLat} from 'ol/proj'
import {computeExtent, toMapCoordsExtent, canvasPxToProductPx} from '../coordinate'

import {ObserverActions} from '../constants'

import {
  fillWithNotScanned,
  NOT_SCANNED_COLOR,
  resolveColorForReflectivity,
  resolveColorGeneric
} from './coloring'


export class Map extends React.Component {
  constructor(props) {
    super(props);

    this.__previousProduct = null;

    this.__onResize = this.__onResize.bind(this);
    this.__updateMap = this.__updateMap.bind(this);
    this.__canvasFunction = this.__canvasFunction.bind(this);

    this.__previousIntendedCenter = [0, 0]

    const cacheOpts = {
      max: 50, // maximum number of items
      maxAge: 1000 * 60 * 15, // items considered over 15 minutes are stale
      stale: false,
    }
    this.__renderedProducts = new LRU(cacheOpts)
    this.__colorCaches = {}
  }

  __onResize() {
    const elem = document.getElementById(this.props.headerElementId)
    const desiredHeight = window.innerHeight - elem.offsetHeight
    const style = '' + desiredHeight + 'px'
    document.getElementById('map-element').style.height = style
    this.map.updateSize()
  }

  __updateMap() {
    if (this.map == undefined) {
      return
    }
    if (this.__previousIntendedCenter[0] != this.props.intendedCenter[0] ||
        this.__previousIntendedCenter[1] != this.props.intendedCenter[1]) {
      const mapProjection = this.map.getView().getProjection()
      this.map.getView().setCenter(fromLonLat(this.props.intendedCenter, mapProjection))
    }
    this.__previousIntendedCenter = this.props.intendedCenter
  }

  componentDidMount() {
    this.map = new OlMap({
      view: new View({
        center: [0, 0],
        zoom: 7
      }),
      layers: [
        new Tile({
          // https://cartodb.com/basemaps
          source: new OSM({
            attributions: [
              ' &copy; <a href="https://cartodb.com/attributions">CartoDB</a>, ' +
              ' &copy; <a href="https://en.ilmatieteenlaitos.fi/open-data-manual-radar-data">FMI Open Radar Data</a>' +
              ' <a href="https://en.ilmatieteenlaitos.fi/open-data-licence">CC BY 4.0</a>, '
            ],
            url: 'https://a.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png'
          })
        }),

        new Tile({
          // https://cartodb.com/basemaps
          source: new OSM({
            url: 'https://a.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
            opaque: false
          })
        })
      ],
      target: 'map-element',
    })

    // Set ratio to 1 for canvas exactly the size of the viewport, i.e. every
    // scroll is a re-render.
    this.imageCanvas = new ImageCanvas({
      canvasFunction: this.__canvasFunction
      // ratio: 1
    })
    this.imageLayer = new Image({ source: this.imageCanvas })
    this.map.getLayers().insertAt(1, this.imageLayer);

    const dispatch = this.props.dispatch
    this.map.on('moveend', function(event) {
      const view = event.map.getView()
      const center = view.getCenter()
      const projection = view.getProjection()
      const lonLatCenter = toLonLat(center, projection)

      dispatch({type: ObserverActions.MAP_MOVED,
        payload: {lon: lonLatCenter[0], lat: lonLatCenter[1]}})
    })

    setTimeout(this.__onResize, 200)
    window.addEventListener('resize', this.__onResize)
    this.__updateMap()
  }

  __canvasFunction(extent, resolution, pixelRatio, size, projection) { // eslint-disable-line no-unused-vars
    const startRender = new Date().getTime();

    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.floor(size[0])
    this.canvas.height = Math.floor(size[1])

    // Short-circuit for cached rendering
    const cacheKey = stringify([this.props.productSelection, this.props.productTime,
      extent, this.canvas.width, this.canvas.height])
    const cached = this.__renderedProducts.get(cacheKey)
    if (cached !== undefined) {
      this.canvas = cached
      return this.canvas
    }

    if (!this.props.product) {
      console.warn('__canvasFunction not rendering because of null currentProduct')
      return this.canvas
    }

    const data = this.props.product.data
    const dataView = new Uint8Array(data)
    const dataRows = this.props.product._rows
    const metadata = this.props.product.metadata

    // Coloring
    let _resolveColor = null
    if (metadata.productInfo.dataType == 'REFLECTIVITY') {
      _resolveColor = resolveColorForReflectivity
    } else {
      _resolveColor = resolveColorGeneric
    }

    // Use the same color cache between calls
    const colorCacheKey = stringify(metadata.productInfo.dataType, metadata.productInfo.dataScale)
    if (!(colorCacheKey in this.__colorCaches)) {
      this.__colorCaches[colorCacheKey] = {}
    }
    const colorCache = this.__colorCaches[colorCacheKey]
    const resolveColor = (value) => {
      if (!(value in colorCache)) {
        colorCache[value] = _resolveColor(metadata.productInfo.dataScale, value)
      }
      return colorCache[value]
    }
    // End of coloring

    const ctx = this.canvas.getContext('2d')
    const imageData = ctx.createImageData(this.canvas.width, this.canvas.height)
    const itemsInARow = imageData.width * 4
    const iData = imageData.data

    const productCoordsExtent = computeExtent(metadata.affineTransform, metadata.width, metadata.height)
    const mapCoordsExtent = toMapCoordsExtent(fromLonLat, productCoordsExtent)
    const mapCoordsWidth = mapCoordsExtent[2] - mapCoordsExtent[0]
    const mapCoordsHeight = mapCoordsExtent[3] - mapCoordsExtent[1]

    // Fill efficiently with NOT_SCANNED_COLOR to reduce array manipulation
    fillWithNotScanned(iData)

    // This cache is a hack that only works with EPSG:3426 products and a
    // EPSG:3857 map.
    const productPxYCache = new Float32Array(this.canvas.height)
    for (let x=0; x<this.canvas.width; x++) {
      let productXComputed = null
      for (let y=0; y<this.canvas.height; y++) {
        let dataPxXY = null

        if (x == 0 || y == 0 || productXComputed == -1 || productPxYCache[y] == -1) {
          dataPxXY = canvasPxToProductPx(
            metadata.affineTransform,
            metadata.width, metadata.height,
            mapCoordsExtent,
            mapCoordsWidth, mapCoordsHeight,
            extent,
            this.canvas.width, this.canvas.height,
            x, y
          )

          if (y == 0 || productXComputed == -1) {
            productXComputed = dataPxXY[0]
          }

          if (x == 0 || productPxYCache[y] == -1) {
            productPxYCache[y] = dataPxXY[1]
          }
        }
        dataPxXY = [productXComputed, productPxYCache[y]]

        if (dataPxXY[0] == -1) { // out of product bounds
          continue
        }
        const value = dataView[dataPxXY[0] * dataRows + dataPxXY[1]]
        const color = resolveColor(value)

        if (color != NOT_SCANNED_COLOR) {
          const redIndex = (y * itemsInARow) + (x * 4);
          iData[redIndex] = color[0]
          iData[redIndex + 1] = color[1]
          iData[redIndex + 2] = color[2]
          iData[redIndex + 3] = color[3]

          // This will likely get faster in the future but for now it's slow:
          //  https://bugs.chromium.org/p/v8/issues/detail?id=3590&desc=2
          // iData.set(color, redIndex)
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

    this.__renderedProducts.set(cacheKey, this.canvas)

    const elapsedMs = new Date().getTime() - startRender;
    const pixelCount = this.canvas.width * this.canvas.height
    console.info('Rendering took', elapsedMs, 'ms @', Math.floor(pixelCount / (elapsedMs / 1000) / 1000), 'kpx/s') // eslint-disable-line no-console

    return this.canvas
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.__onResize)
  }

  render() {
    if (this.__previousProduct == null || this.previousProduct != this.props.product) {
      this.__previousProduct == this.props.product
      if (this.imageCanvas !== undefined) {
        this.imageCanvas.changed()
      }
    }

    this.__updateMap()

    return (
      <div id="map-element"></div>
    )
  }
}
