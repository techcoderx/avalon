module.exports = (value, canBeZero, canBeNegative, max, min) => {
    if (!max)
        max = Math.pow(2,20) - 1
    if (!min)
        if (canBeNegative)
            min = -(Math.pow(2,20) - 1)
        else
            min = 0
    
    if (typeof value !== 'number')
        return false
    if (!canBeZero && value === 0)
        return false
    if (!canBeNegative && value < 0)
        return false
    if (value > max)
        return false
    if (value < min)
        return false

    return true
}