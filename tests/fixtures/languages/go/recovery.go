package recovery

// Total adds the values.
func Total(values []int) int {
    total := 0
    for _, value := range values {
        total += value
    }
    return total
}

// Broken is missing the closing parenthesis of its parameter list.
func Broken(values []int {
    return len(values)
}

// Mean averages the values.
func Mean(values []int) float64 {
    if len(values) == 0 {
        return 0
    }
    return float64(Total(values)) / float64(len(values))
}

// Max returns the largest value.
func Max(values []int) int {
    best := values[0]
    for _, value := range values[1:] {
        if value > best {
            best = value
        }
    }
    return best
}
