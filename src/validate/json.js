// content json and profile

module.exports = (value, max) => {
    if (!max)
        max = Number.MAX_SAFE_INTEGER
    if (!value)
        return false
    if (typeof value !== 'object')
        return false
    try {
        if (JSON.stringify(value).length > max)
            return false
    } catch (error) {
        return false
    }

    return true
}